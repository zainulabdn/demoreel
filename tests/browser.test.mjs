// Tests that need a real browser. They are skipped when no Chrome, Edge or Brave is
// installed, or when DEMOREEL_E2E=0 is set.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome } from '../skills/demoreel/scripts/lib/chrome.mjs';
import { Page } from '../skills/demoreel/scripts/lib/page.mjs';
import { startStaticServer } from '../skills/demoreel/scripts/lib/serve.mjs';
import { DemoreelError } from '../skills/demoreel/scripts/lib/util.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'skills/demoreel/scripts/demoreel.mjs');

let skip = false;
if (process.env.DEMOREEL_E2E === '0') skip = 'DEMOREEL_E2E=0';
else {
  try {
    findChrome();
  } catch {
    skip = 'no Chrome, Edge or Brave found';
  }
}

describe('finding and driving elements in a real page', { skip }, () => {
  let browser;
  let server;
  let page;

  before(async () => {
    server = await startStaticServer(join(ROOT, 'tests/fixtures'));
    browser = await launchChrome({ width: 1000, height: 700, scale: 1 });
    page = await Page.open(browser.connection, { width: 1000, height: 700, pace: 0 });
    await page.goto(`${server.origin}/locate.html`);
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  // Every test starts from the top of the page, whatever the one before it did.
  beforeEach(async () => {
    await page.call('scrollPage', 'top', 1);
  });

  const find = (query, options) => page.locate(query, { timeout: 500, ...options });
  const value = (expression) => page.evaluate(`return ${expression};`);

  test('an exact name wins over a longer one that contains it', async () => {
    assert.equal((await find('Save')).label, 'button "Save"');
    assert.equal((await find('save draft')).label, 'button "Save draft"');
  });

  test('icon buttons are found by their accessible name', async () => {
    const found = await find('Close dialog');
    assert.equal(found.tag, 'button');
    assert.equal(found.cursor, 'default');
  });

  test('fields are found by label and by placeholder', async () => {
    const email = await find('Email address', { mode: 'edit' });
    assert.equal(email.tag, 'input');
    assert.equal(email.editable, true);
    assert.equal(email.cursor, 'text');
    assert.equal((await find('Search projects', { mode: 'edit' })).tag, 'input');
  });

  test('text inside a clickable card resolves to the card', async () => {
    const card = await find('Pro plan');
    assert.equal(card.tag, 'div');
    assert.equal(card.cursor, 'pointer');
    assert.ok(card.rect.w > 200, 'the whole card, not just the heading');
    assert.equal((await find('Open settings')).cursor, 'pointer');
  });

  test('links get a pointer cursor', async () => {
    assert.equal((await find('Pricing')).cursor, 'pointer');
  });

  test('nth picks among several elements with the same name', async () => {
    const first = await find('Add', { nth: 1 });
    const second = await find('Add', { nth: 2 });
    assert.ok(second.rect.y > first.rect.y);
    await assert.rejects(find('Add', { nth: 3 }), /Only 2 element/);
  });

  test('css, text and testid prefixes are understood', async () => {
    assert.equal((await find('#save-draft')).label, 'button "Save draft"');
    assert.equal((await find('css=section .add')).tag, 'button');
    assert.equal((await find('text=Just a paragraph')).tag, 'p');
    await assert.rejects(find('css=div[[['), /not a valid CSS selector/);
  });

  test('elements inside shadow DOM are found and clickable', async () => {
    const found = await find('Shadow action');
    await page.click(found.point.x, found.point.y);
    assert.equal(await value('window.picked'), 'shadow');
  });

  test('hidden elements are not found, and the error says what is on screen', async () => {
    await assert.rejects(find('Ghost'), (error) => {
      assert.ok(error instanceof DemoreelError);
      assert.match(error.message, /Could not find "Ghost" to use/);
      assert.match(error.hint, /On screen now: .*"Save"/);
      return true;
    });
  });

  test('a typo gets a "did you mean" suggestion', async () => {
    await assert.rejects(find('Save drft'), (error) => {
      assert.match(error.hint, /Did you mean: .*"Save draft"/);
      return true;
    });
  });

  test('a disabled element is reported as disabled, not as missing', async () => {
    await assert.rejects(find('Delete'), /disabled right now/);
  });

  test('optional targets return null instead of failing', async () => {
    assert.equal(await find('Accept cookies', { optional: true }), null);
  });

  test('an off-screen element is scrolled into view before use', async () => {
    const before = await find('Far below');
    assert.equal(before.needsScroll, true);
    assert.ok(before.rect.y > 700, 'starts below the visible area');
    const revealed = await page.reveal('Far below', before, { timeout: 2000 });
    assert.ok(revealed.rect.y > 0 && revealed.rect.y + revealed.rect.h <= 700, 'ends fully inside it');
    assert.equal(revealed.covered, false);
  });

  test('an element in the middle of a long page is centred when revealed', async () => {
    await page.call('scrollPage', 'bottom', 1);
    const before = await find('Save draft');
    assert.equal(before.needsScroll, true);
    const revealed = await page.reveal('Save draft', before, { timeout: 2000 });
    assert.equal(revealed.needsScroll, false);
    assert.ok(revealed.rect.y >= 24 && revealed.rect.y < 400);
  });

  test('clicking really clicks', async () => {
    const found = await find('Clicked 0 times');
    await page.moveTo(found.point.x, found.point.y);
    await page.click(found.point.x, found.point.y);
    await page.click(found.point.x, found.point.y);
    assert.equal(await value('document.getElementById("counter").textContent'), 'Clicked 2 times');
  });

  test('typing fills the field, including capitals, symbols and non-Latin text', async () => {
    const found = await find('Email address', { mode: 'edit' });
    await page.click(found.point.x, found.point.y);
    await page.typeText('Zain+test@Example.com');
    assert.equal(await value('document.getElementById("email").value'), 'Zain+test@Example.com');
    assert.ok((await page.call('selectLastContents')) > 0);
    await page.pressKey('Backspace');
    await page.typeText('سلام café');
    assert.equal(await value('document.getElementById("email").value'), 'سلام café');
  });

  test('shortcuts reach the page with their modifier keys', async () => {
    await page.evaluate('window.keys = [];');
    await page.pressKey('Control+K');
    await page.pressKey('Shift+Tab');
    await page.pressKey('Escape');
    assert.deepEqual(await value('window.keys'), ['Control+k', 'Shift+Tab', 'Escape']);
  });

  test('native dropdowns are set by option text', async () => {
    await find('Country', { mode: 'edit' });
    const result = await page.call('selectOption', 'turkey');
    assert.deepEqual(result, { ok: true, label: 'Turkey' });
    assert.equal(await value('document.getElementById("country").value'), 'Turkey');
    assert.equal((await page.call('selectOption', 'Atlantis')).ok, false);
  });

  test('the camera is told which area changed after an action', async () => {
    await page.call('markChanges');
    const found = await find('css=#counter');
    await page.click(found.point.x, found.point.y);
    await page.settle({ min: 100 });
    const changed = await page.call('changeRect');
    assert.ok(changed, 'a change was noticed');
    assert.ok(Math.abs(changed.x - found.rect.x) < 2 && Math.abs(changed.y - found.rect.y) < 2, 'and it is the counter button');
    assert.equal(await page.call('changeRect'), null, 'tracking stops after it is read');
  });

  test('a covered element is used anyway, with a warning that names what covers it', async () => {
    await page.evaluate('document.getElementById("overlay").style.display = "block";');
    const found = await page.locate('Covered button', { timeout: 4000 });
    assert.equal(found.covered, true);
    assert.match(page.warnings.at(-1), /"Covered button" is covered by div/);
    await page.evaluate('document.getElementById("overlay").style.display = "none";');
  });
});

describe('recording the example app end to end', { skip }, () => {
  const outDir = mkdtempSync(join(tmpdir(), 'demoreel-e2e-'));
  after(() => rmSync(outDir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 240000 });

  // Some browsers (plain Chromium builds) cannot encode H.264. Without ffmpeg either,
  // MP4 is unavailable on that machine and only the GIF can be checked.
  let canMakeMp4 = true;

  test('doctor reports this machine as ready', () => {
    const result = run(['doctor', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    canMakeMp4 = report.h264 || report.ffmpeg;
  });

  test('check runs every step and saves a screenshot of each', () => {
    const result = run(['check', join(ROOT, 'examples/lumen/demo.reel.json'), '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.steps.length, 16);
    assert.ok(report.steps.every((step) => step.status === 'done' && existsSync(step.screenshot)));
  });

  test('check fails clearly on a step that cannot work', () => {
    const story = join(outDir, 'broken.reel.json');
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(story)}, JSON.stringify({ serve: ${JSON.stringify(join(ROOT, 'examples/lumen'))}, steps: [{ click: 'New project' }, { click: 'Creat projct', timeout: 600 }] }))`]);
    const result = run(['check', story]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Step 2 \(click "Creat projct"\) failed/);
    assert.match(result.stderr, /Did you mean: "Create project"/);
    assert.match(result.stderr, /Screenshot of the page at that moment/);
  });

  test('record produces a playable MP4, a GIF, a poster and a contact sheet', () => {
    const formats = canMakeMp4 ? 'mp4,gif' : 'gif';
    const result = run(['record', join(ROOT, 'examples/lumen/demo.reel.json'), '--out', outDir, '--formats', formats, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.files.map((file) => file.kind).sort(), canMakeMp4 ? ['gif', 'mp4', 'poster', 'sheet'] : ['gif', 'poster', 'sheet']);
    assert.ok(report.durationMs > 15000 && report.durationMs < 40000, `duration ${report.durationMs}`);

    if (canMakeMp4) {
      const mp4 = readFileSync(join(outDir, 'demo.mp4'));
      const boxes = [];
      for (let offset = 0; offset < mp4.length; ) {
        const size = mp4.readUInt32BE(offset);
        boxes.push(mp4.toString('latin1', offset + 4, offset + 8));
        offset += size;
      }
      assert.ok(boxes.includes('moov') && boxes.includes('mdat'), `boxes: ${boxes}`);
      assert.ok(mp4.length > 500_000, 'has real video in it');
      assert.ok(mp4.length < 9_500_000, 'stays under the default size limit');
    }

    const gif = readFileSync(join(outDir, 'demo.gif'));
    assert.equal(gif.toString('latin1', 0, 6), 'GIF89a');
    assert.equal(gif.readUInt16LE(6), 960);
    assert.equal(gif.at(-1), 0x3b);

    for (const name of ['demo.poster.png', 'demo.sheet.png']) {
      const png = readFileSync(join(outDir, name));
      assert.equal(png.toString('latin1', 1, 4), 'PNG');
      assert.ok(statSync(join(outDir, name)).size > 20_000);
    }
    assert.equal(png1080(readFileSync(join(outDir, 'demo.poster.png'))), '1920x1080');
  });

  test('record with sound: spoken lines set the pace, and the MP4 gets a sound track', (t) => {
    if (!canMakeMp4) return t.skip('sound needs an MP4, which this machine cannot make');
    // A stand-in voice that works on every system: a tone that lasts longer for longer text.
    const speak = join(ROOT, 'tests/fixtures/speak.mjs');
    const long = 'A new project takes a few seconds, and this sentence is long.';
    const story = join(outDir, 'narrated.reel.json');
    writeFileSync(
      story,
      JSON.stringify({
        serve: join(ROOT, 'examples/lumen'),
        sound: { voice: { command: `'${process.execPath}' '${speak}' {out}` } },
        output: { formats: ['mp4', 'srt'], size: '720p' },
        steps: [
          { say: 'Start a project in seconds', speak: long },
          { say: 'Second line right away' },
          { click: 'New project' },
          { type: 'Hi', into: 'Project name' },
        ],
      }),
    );
    const result = run(['record', story, '--out', outDir, '--keep', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    after(() => rmSync(report.recording, { recursive: true, force: true }));
    assert.equal(report.voice.lines.length, 2);
    assert.equal(report.voice.lines[0].text, long);
    assert.ok(report.voice.lines[1].heldBackMs > 1000, 'the report says the second line had to wait for the first');
    assert.equal(report.sound.voiceLines, 2);
    assert.ok(report.sound.effects >= 3, 'a click and two typed letters at least');

    // The recording waited for the voice: the second line starts after the first has finished,
    // and the video does not end in the middle of the last one.
    const timeline = JSON.parse(readFileSync(join(report.recording, 'timeline.json'), 'utf8'));
    const [first, second] = timeline.voice;
    const spokenFor = (text) => (0.3 + text.length * 0.04) * 1000;
    assert.ok(Math.abs(first.duration - spokenFor(long)) < 200, `first line measured as ${first.duration} ms`);
    assert.ok(first.skip > 150 && first.skip <= 200, `the silence the voice adds before speaking is skipped (${first.skip} ms)`);
    assert.ok(second.t >= first.t + first.duration + 250, 'one voice at a time');
    assert.ok(timeline.duration >= second.t + second.duration + 600, 'the last line is not cut off');
    assert.ok(timeline.keys.length >= 2 && timeline.clicks.length >= 1);

    const srt = readFileSync(join(outDir, 'narrated.srt'), 'utf8');
    assert.match(srt, new RegExp(`^1\\n00:00:0\\d,\\d{3} --> 00:00:0\\d,\\d{3}\\n${long}\\n\\n2\\n`));
    assert.match(srt, /Second line right away\n$/);

    const mp4 = readFileSync(join(outDir, 'narrated.mp4'));
    if (report.sound.encoder === 'none') {
      // No AAC encoder in this browser and no ffmpeg: the soundtrack is saved beside a silent video.
      assert.ok(report.files.some((file) => file.kind === 'soundtrack'));
      assert.equal(readFileSync(join(outDir, 'narrated.wav')).toString('latin1', 0, 4), 'RIFF');
    } else {
      assert.ok(mp4.includes(Buffer.from('soun')), 'the MP4 has a sound track');
      assert.ok(mp4.includes(Buffer.from('mp4a')), 'encoded as AAC');
    }
  });
});

function png1080(buffer) {
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}
