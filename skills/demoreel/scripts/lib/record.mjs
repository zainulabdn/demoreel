// The recording pass: open the app, perform every storyboard step like a person would,
// and write down what happened (frames, cursor path, clicks, captions) on a timeline.
// The timeline is later turned into the finished video by the render pass.

import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchChrome } from './chrome.mjs';
import { DEFAULT_HIDE, NULL_TAPE, Page } from './page.mjs';
import { startCommand, startStaticServer } from './serve.mjs';
import { DemoreelError, frameName, hashString, seededRandom, sleep } from './util.mjs';
import { measureClips } from './voice.mjs';

const round1 = (value) => Math.round(value * 10) / 10;

/** A spoken line starts this long after its caption appears, so the eye gets there first. */
const VOICE_LEAD = 80;
/** The shortest silence between two spoken lines. */
const VOICE_GAP = 280;
/** How long the video runs on after the last word. */
const VOICE_TAIL = 700;

/** Collects everything that happens during a recording, on one clock (ms since the first frame). */
export class Tape {
  constructor(dir) {
    this.dir = dir;
    this.framesDir = join(dir, 'frames');
    mkdirSync(this.framesDir, { recursive: true });
    this.t0 = 0;
    this.started = false;
    this.frames = [];
    this.cursorSamples = [];
    this.cursorKinds = [];
    this.clicks = [];
    this.focus = [];
    this.wide = [];
    this.captions = [];
    this.keys = [];
    this.voice = [];
    this.urls = [];
    this.steps = [];
    this.writes = [];
  }

  start(epochMs) {
    this.t0 = epochMs;
    this.started = true;
  }

  now() {
    return this.started ? Math.max(0, Math.round(Date.now() - this.t0)) : 0;
  }

  addFrame(base64, epochMs) {
    if (!this.started) return;
    const file = frameName(this.frames.length);
    this.frames.push({ t: Math.max(0, Math.round(epochMs - this.t0)), file });
    this.writes.push(writeFile(join(this.framesDir, file), Buffer.from(base64, 'base64')));
  }

  cursor(x, y) {
    this.cursorSamples.push([this.now(), round1(x), round1(y)]);
  }

  cursorKind(kind) {
    const last = this.cursorKinds[this.cursorKinds.length - 1];
    if (!last || last.kind !== kind) this.cursorKinds.push({ t: this.now(), kind });
  }

  click(x, y) {
    this.clicks.push({ t: this.now(), x: round1(x), y: round1(y) });
  }

  /** A key going down, for the typing sounds. `kind` is "char", "space", "enter" or "key". */
  key(kind) {
    this.keys.push({ t: this.now(), kind });
  }

  /** A spoken line starting at `entry.t`. See runStep's "say" for what an entry holds. */
  speak(entry) {
    this.voice.push(entry);
  }

  /** A moment the camera should look at: a click, some typing, a hover or an explicit zoom. */
  addFocus(event) {
    this.focus.push(event);
  }

  /** A stretch of time where the camera should show the whole page (scrolls, drags, navigation). */
  addWide(t0, t1, reason) {
    this.wide.push({ t0, t1, reason });
  }

  scroll(t0, t1) {
    this.addWide(t0, t1, 'scroll');
  }

  say(text, duration) {
    const now = this.now();
    const open = this.captions[this.captions.length - 1];
    if (open && open.t1 === null) open.t1 = now;
    if (text) this.captions.push({ t0: now, t1: duration ? now + duration : null, text });
  }

  url(url) {
    const last = this.urls[this.urls.length - 1];
    if (!last || last.url !== url) this.urls.push({ t: this.now(), url });
  }

  async finish(viewport, scale) {
    await Promise.all(this.writes);
    const duration = this.now();
    for (const caption of this.captions) if (caption.t1 === null || caption.t1 > duration) caption.t1 = duration;
    const timeline = {
      version: 1,
      viewport: { ...viewport, scale },
      duration,
      frames: this.frames,
      cursor: this.cursorSamples,
      cursorKinds: this.cursorKinds,
      clicks: this.clicks,
      focus: this.focus,
      wide: this.wide,
      captions: this.captions,
      keys: this.keys,
      voice: this.voice,
      urls: this.urls,
      steps: this.steps,
    };
    writeFileSync(join(this.dir, 'timeline.json'), JSON.stringify(timeline));
    return timeline;
  }
}

/** The smallest rectangle containing both. */
export function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Join a step's "goto" value onto the storyboard's base URL. */
export function resolveUrl(base, target) {
  try {
    return new URL(target, base).href;
  } catch {
    throw new DemoreelError(`"${target}" is not a valid URL or path.`);
  }
}

async function runStep(step, page, tape, context) {
  const options = { nth: step.nth, timeout: step.timeout, optional: step.optional };
  const approachAndPoint = async (found) => {
    await page.wait(110);
    const moveStart = tape.now();
    await page.moveTo(found.point.x, found.point.y);
    tape.cursorKind(found.cursor);
    await page.wait(130);
    return tape.now() - moveStart;
  };
  const refreshCursorKind = async () => {
    const kind = await page.call('cursorAt', page.mouse.x, page.mouse.y);
    if (kind) tape.cursorKind(kind);
  };
  // After an action, tell the camera where the page changed, so it can follow the result
  // (a dialog opening in the middle of the page, a new row appearing, a toast).
  const followResult = async (t, origin) => {
    const changed = await page.call('changeRect');
    if (!changed) return;
    tape.addFocus({ kind: 'result', t0: t + 180, t1: tape.now(), rect: origin ? unionRect(origin, changed) : changed });
  };

  switch (step.action) {
    case 'goto': {
      const start = tape.now();
      await page.goto(resolveUrl(context.baseUrl, step.url));
      tape.addWide(start, tape.now(), 'navigation');
      await refreshCursorKind();
      return 'done';
    }

    case 'click': {
      let found = await page.locate(step.target, { ...options, mode: 'click', action: 'click' });
      if (!found) return 'skipped';
      found = await page.reveal(step.target, found, { ...options, mode: 'click', action: 'click' });
      const approach = await approachAndPoint(found);
      const t = tape.now();
      tape.addFocus({ kind: 'click', t0: t, t1: t + 150, approach, rect: found.rect, zoom: step.zoom });
      await page.call('markChanges');
      await page.click(found.point.x, found.point.y);
      await page.settle({ min: 320 });
      if (step.zoom !== false) await followResult(t, found.rect);
      await refreshCursorKind();
      return 'done';
    }

    case 'hover': {
      let found = await page.locate(step.target, { ...options, mode: 'click', action: 'hover over' });
      if (!found) return 'skipped';
      found = await page.reveal(step.target, found, { ...options, mode: 'click', action: 'hover over' });
      await page.call('markChanges');
      const approach = await approachAndPoint(found);
      const t = tape.now();
      await page.wait(650);
      tape.addFocus({ kind: 'hover', t0: t, t1: tape.now(), approach, rect: found.rect, zoom: step.zoom });
      await page.settle({ min: 100, max: 1200 });
      if (step.zoom !== false) await followResult(t, found.rect);
      return 'done';
    }

    case 'type': {
      let rect;
      let approach = 0;
      if (step.target) {
        let found = await page.locate(step.target, { ...options, mode: 'edit', action: 'type into' });
        if (!found) return 'skipped';
        found = await page.reveal(step.target, found, { ...options, mode: 'edit', action: 'type into' });
        approach = await approachAndPoint(found);
        await page.click(found.point.x, found.point.y);
        await page.call('focusLast');
        await page.wait(180);
        rect = found.rect;
      } else {
        const active = await page.call('activeField');
        if (!active?.ok || !active.editable) {
          throw new DemoreelError(
            'There is no focused field to type into.',
            'Add "into": "<field name>" to this step, or click the field in the step before it.',
          );
        }
        rect = active.rect;
      }
      if (step.clear && (await page.call('selectLastContents')) > 0) {
        await page.wait(120);
        await page.pressKey('Backspace');
        await page.wait(160);
      }
      const t0 = tape.now();
      await page.typeText(step.text, { speed: step.speed });
      tape.addFocus({ kind: 'type', t0, t1: tape.now(), approach, rect, zoom: step.zoom });
      await page.wait(200);
      await page.settle({ min: 120, max: 1200 });
      return 'done';
    }

    case 'press': {
      await page.wait(140);
      const active = await page.call('activeField');
      await page.call('markChanges');
      const t = tape.now();
      await page.pressKey(step.key);
      tape.addFocus({ kind: 'key', t0: t, t1: t + 100 });
      await page.settle({ min: 320 });
      await followResult(t, active?.ok ? active.rect : null);
      await refreshCursorKind();
      return 'done';
    }

    case 'scroll': {
      const start = tape.now();
      if (step.target) {
        const found = await page.locate(step.target, { ...options, mode: 'click', action: 'scroll to' });
        if (!found) return 'skipped';
        await page.call('scrollLastIntoView', page.pace === 0 ? 1 : undefined);
      } else {
        await page.call('scrollPage', step.amount, page.pace === 0 ? 1 : undefined);
      }
      tape.scroll(start, tape.now());
      await page.wait(260);
      await refreshCursorKind();
      return 'done';
    }

    case 'wait':
      await page.wait(step.ms);
      return 'done';

    case 'waitFor':
      await page.locate(step.target, { nth: step.nth, timeout: step.timeout ?? 15000, mode: 'click', action: 'wait for' });
      return 'done';

    case 'say': {
      const clip = context.voice?.get(step.index);
      if (!clip) {
        tape.say(step.text, step.duration);
        await page.wait(step.text ? 380 : 0);
        return 'done';
      }
      // One voice at a time: the line before this one finishes first.
      const waited = Math.max(0, Math.round(context.voiceEnd + VOICE_GAP - tape.now()));
      await sleep(waited);
      // A caption with a time limit still stays up while its line is being spoken.
      tape.say(step.text, step.duration ? Math.max(step.duration, clip.duration + 250) : undefined);
      const t = tape.now() + VOICE_LEAD;
      // "waited" is how long this line was held back, which tells the author the line before it is too long for its beat.
      tape.speak({ t, step: step.index, file: clip.file, skip: clip.skip, duration: clip.duration, text: clip.text, ...(waited > 50 ? { waited } : {}) });
      context.voiceEnd = t + clip.duration;
      await page.wait(380);
      return 'done';
    }

    case 'select': {
      let found = await page.locate(step.target, { ...options, mode: 'edit', action: 'select from' });
      if (!found) return 'skipped';
      if (!found.isSelect) {
        throw new DemoreelError(
          `"${step.target}" is not a native <select> dropdown.`,
          'For custom dropdowns, use a "click" on the dropdown and then a "click" on the option.',
        );
      }
      found = await page.reveal(step.target, found, { ...options, mode: 'edit', action: 'select from' });
      const approach = await approachAndPoint(found);
      const t = tape.now();
      tape.click(found.point.x, found.point.y);
      await page.wait(240);
      await page.call('markChanges');
      const result = await page.call('selectOption', step.option);
      if (!result?.ok) {
        throw new DemoreelError(
          `${result?.reason || 'Could not pick that option.'}`,
          result?.visible?.length ? `Options: ${result.visible.map((o) => `"${o}"`).join(', ')}.` : undefined,
        );
      }
      tape.addFocus({ kind: 'click', t0: t, t1: tape.now(), approach, rect: found.rect, zoom: step.zoom });
      await page.settle({ min: 250 });
      if (step.zoom !== false) await followResult(t, found.rect);
      return 'done';
    }

    case 'drag': {
      let source = await page.locate(step.target, { ...options, mode: 'click', action: 'drag' });
      source = await page.reveal(step.target, source, { ...options, mode: 'click', action: 'drag' });
      const start = tape.now();
      await page.wait(110);
      await page.moveTo(source.point.x, source.point.y);
      tape.cursorKind('grab');
      await page.wait(160);
      await page.mouseDown(source.point.x, source.point.y);
      await page.wait(180);
      // A small first nudge lets drag libraries notice the drag has started.
      await page.moveTo(source.point.x + 6, source.point.y + 6, { buttons: 1 });
      const destination = await page.locate(step.to, { timeout: step.timeout, mode: 'click', action: 'drop on' });
      await page.moveTo(destination.point.x, destination.point.y, { buttons: 1 });
      await page.wait(200);
      await page.mouseUp(destination.point.x, destination.point.y);
      tape.addWide(start, tape.now(), 'drag');
      await page.settle({ min: 320 });
      await refreshCursorKind();
      return 'done';
    }

    case 'zoom': {
      const t = tape.now();
      if (step.out) {
        tape.addWide(t, t + 300, 'zoom out');
        await page.wait(700);
        return 'done';
      }
      const found = await page.locate(step.target, { ...options, mode: 'click', action: 'zoom to' });
      const revealed = await page.reveal(step.target, found, { ...options, mode: 'click', action: 'zoom to' });
      const now = tape.now();
      tape.addFocus({ kind: 'zoom', t0: now + 350, t1: now + 1200, approach: 350, rect: revealed.rect, zoom: step.level });
      await page.wait(1200);
      return 'done';
    }

    case 'eval':
      await page.evaluate(step.code);
      await page.settle({ min: 200 });
      return 'done';

    default:
      throw new DemoreelError(`Unknown action "${step.action}".`);
  }
}

/**
 * Start whatever serves the app (a static folder, the app's dev server, or nothing
 * if it is already running) and return the base URL to open.
 */
export async function startApp(storyboard) {
  const closers = [];
  let baseUrl = storyboard.url;
  if (storyboard.serve) {
    const server = await startStaticServer(storyboard.serve);
    closers.push(server.close);
    baseUrl = resolveUrl(`${server.origin}/`, storyboard.url.replace(/^https?:\/\/[^/]+/, '') || '/');
  } else if (storyboard.start) {
    const started = await startCommand(storyboard.start, storyboard.url);
    closers.push(started.close);
  }
  return {
    baseUrl,
    close: async () => {
      for (const close of closers) await close().catch(() => {});
    },
  };
}

/**
 * Run the storyboard in a real browser.
 *
 * @param {object} storyboard  from normalizeStoryboard
 * @param {object} options
 * @param {'record'|'check'} options.mode  "check" runs the steps fast and saves a screenshot after each
 * @param {string} options.workDir  where frames, timeline or check screenshots are written
 * @param {Map<number, object>} [options.voice]  spoken lines by step number, from prepareVoice
 * @param {(event: object) => void} [options.onStep]
 */
export async function runStoryboard(storyboard, { mode = 'record', workDir, chromePath, headed = false, voice = null, onStep = () => {} }) {
  mkdirSync(workDir, { recursive: true });
  const checking = mode === 'check';
  const app = await startApp(storyboard);
  let browser;
  const results = [];
  try {
    browser = await launchChrome({
      chromePath,
      width: storyboard.viewport.width,
      height: storyboard.viewport.height,
      scale: storyboard.scale,
      headed,
    });
    const seed = storyboard.seed ?? hashString(JSON.stringify(storyboard.steps.map((s) => s.label)));
    const tape = checking ? null : new Tape(workDir);
    // How long each spoken line is decides the pace, so the clips are measured before anything is filmed.
    const speaking = tape && voice?.size ? await measureClips(browser.connection, workDir, voice) : null;
    const context = { baseUrl: app.baseUrl, voice: speaking, voiceEnd: -Infinity };
    const page = await Page.open(browser.connection, {
      width: storyboard.viewport.width,
      height: storyboard.viewport.height,
      mobile: storyboard.viewport.mobile,
      theme: storyboard.theme,
      hide: [...DEFAULT_HIDE, ...storyboard.hide],
      random: seededRandom(seed),
      pace: checking ? 0 : storyboard.pace,
      tape: tape || undefined,
    });
    const session = page.session;

    await page.goto(app.baseUrl);

    const fps = storyboard.output.fps;
    if (tape) {
      const trackUrl = (url) => tape.url(url);
      session.on('Page.frameNavigated', (params) => {
        if (!params.frame.parentId) trackUrl(params.frame.url);
      });
      session.on('Page.navigatedWithinDocument', (params) => trackUrl(params.url));

      let firstFrame;
      const gotFirstFrame = new Promise((resolve) => {
        firstFrame = resolve;
      });
      session.on('Page.screencastFrame', (params) => {
        session.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
        const epochMs = params.metadata.timestamp * 1000;
        if (!tape.started) {
          tape.start(epochMs);
          firstFrame();
        }
        tape.addFrame(params.data, epochMs);
      });
      await session.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: fps > 30 ? 1 : 2 });
      await Promise.race([gotFirstFrame, sleep(1200)]);
      if (!tape.started) {
        // A completely still page may not produce a frame on its own: take one by hand.
        const { data } = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
        tape.start(Date.now());
        tape.addFrame(data, Date.now());
      }
      tape.url(await page.url());
      tape.cursor(page.mouse.x, page.mouse.y);
      tape.cursorKind('default');
      await page.wait(650);
    }

    for (const step of storyboard.steps) {
      const entry = { index: step.index, label: step.label, t0: tape ? tape.now() : 0 };
      onStep({ type: 'start', step });
      let status;
      try {
        status = await runStep(step, page, tape || NULL_TAPE, context);
      } catch (error) {
        let screenshot = null;
        try {
          screenshot = join(workDir, `step-${String(step.index + 1).padStart(2, '0')}-failed.jpg`);
          const { data } = await session.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 70,
            clip: { x: 0, y: 0, width: storyboard.viewport.width, height: storyboard.viewport.height, scale: 1 / storyboard.scale },
          });
          writeFileSync(screenshot, Buffer.from(data, 'base64'));
        } catch {
          screenshot = null;
        }
        results.push({ index: step.index, label: step.label, status: 'failed', error: error.message, hint: error.hint, screenshot });
        onStep({ type: 'failed', step, error });
        const wrapped = new DemoreelError(`Step ${step.index + 1} (${step.label}) failed: ${error.message}`, error.hint);
        wrapped.stepIndex = step.index;
        wrapped.screenshot = screenshot;
        wrapped.results = results;
        wrapped.pageErrors = page.pageErrors;
        throw wrapped;
      }
      if (step.pause) await page.wait(step.pause);
      entry.t1 = tape ? tape.now() : 0;
      if (tape) tape.steps.push(entry);

      let screenshot = null;
      if (checking) {
        screenshot = join(workDir, `step-${String(step.index + 1).padStart(2, '0')}.jpg`);
        const { data } = await session.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 70,
          clip: { x: 0, y: 0, width: storyboard.viewport.width, height: storyboard.viewport.height, scale: 1 / storyboard.scale },
        });
        writeFileSync(screenshot, Buffer.from(data, 'base64'));
      }
      results.push({ index: step.index, label: step.label, status, screenshot });
      onStep({ type: status, step });
    }

    let timeline = null;
    if (tape) {
      await page.wait(1300);
      // Never cut off the last spoken line.
      await sleep(context.voiceEnd + VOICE_TAIL - tape.now());
      await session.send('Page.stopScreencast').catch(() => {});
      timeline = await tape.finish(storyboard.viewport, storyboard.scale);
      if (timeline.frames.length < 2) {
        throw new DemoreelError('The recording captured no frames.', 'Run "demoreel doctor" to check the browser.');
      }
    }
    return { timeline, results, warnings: page.warnings, pageErrors: page.pageErrors, browser: browser.product };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await app.close();
  }
}
