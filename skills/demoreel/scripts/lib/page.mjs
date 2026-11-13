// Drives one browser tab like a person would: moves the mouse along a path, clicks,
// types with a human rhythm, scrolls smoothly, and waits for the page to settle.

import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { planMove } from './cursorpath.mjs';
import { DemoreelError, sleep } from './util.mjs';

const INPAGE_SOURCE = readFileSync(new URL('./inpage.js', import.meta.url), 'utf8');

/** Developer-tool badges that should never appear in a demo video. */
export const DEFAULT_HIDE = [
  'nextjs-portal',
  '#__next-build-watcher',
  'astro-dev-toolbar',
  '#nuxt-devtools-container',
  '.tsqd-parent-container',
  '.ReactQueryDevtools',
  '#webpack-dev-server-client-overlay',
  '.vue-devtools__anchor',
];

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const KEY_ALIASES = {
  esc: 'Escape', return: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  cmd: 'Meta', command: 'Meta', ctrl: 'Control', option: 'Alt', opt: 'Alt', del: 'Delete', spacebar: 'Space',
};

const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

/**
 * Turn "Mod+K" or "Enter" into what the browser needs to press it.
 * "Mod" is Command on macOS and Control elsewhere.
 */
export function parseKeyCombo(combo, plat = platform()) {
  const parts = String(combo).split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new DemoreelError(`"${combo}" is not a key.`);
  const resolve = (name) => {
    if (name.toLowerCase() === 'mod') return plat === 'darwin' ? 'Meta' : 'Control';
    const alias = KEY_ALIASES[name.toLowerCase()];
    if (alias) return alias;
    const named = Object.keys(NAMED_KEYS).concat(Object.keys(MODIFIER_BITS)).find((k) => k.toLowerCase() === name.toLowerCase());
    return named || name;
  };
  const names = parts.map(resolve);
  const keyName = names.pop();
  let modifiers = 0;
  for (const name of names) {
    if (!(name in MODIFIER_BITS)) {
      throw new DemoreelError(`"${name}" is not a modifier key.`, 'Use Shift, Control, Alt, Meta or Mod, for example "Mod+K".');
    }
    modifiers |= MODIFIER_BITS[name];
  }
  if (keyName in MODIFIER_BITS) throw new DemoreelError(`"${combo}" needs a key after the modifier, for example "Mod+K".`);

  let definition = NAMED_KEYS[keyName];
  if (!definition) {
    if ([...keyName].length !== 1) {
      throw new DemoreelError(
        `"${keyName}" is not a key Demoreel knows.`,
        `Use a single character or one of: ${Object.keys(NAMED_KEYS).join(', ')}.`,
      );
    }
    const upper = keyName.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(keyName);
    const shifted = (modifiers & MODIFIER_BITS.Shift) !== 0;
    definition = {
      key: isLetter ? (shifted ? upper : keyName.toLowerCase()) : keyName,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${keyName}` : '',
      vk: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: isLetter ? (shifted ? upper : keyName.toLowerCase()) : keyName,
    };
  }
  // With Control, Alt or Meta held, a key is a shortcut and types nothing.
  const typesText = (modifiers & ~MODIFIER_BITS.Shift) === 0;
  return { ...definition, modifiers, text: typesText ? definition.text : undefined };
}

const isContextError = (text) =>
  /context|navigat|Target closed|Inspected target|Promise was collected|Cannot find/i.test(String(text));

/** A recorder that does nothing, used when steps are only being checked. */
export const NULL_TAPE = {
  now: () => 0,
  cursor() {},
  cursorKind() {},
  click() {},
  scroll() {},
  say() {},
  addFocus() {},
  addWide() {},
};

export class Page {
  /**
   * @param {import('./chrome.mjs').Session} session
   * @param {object} options
   */
  constructor(session, options) {
    this.session = session;
    this.width = options.width;
    this.height = options.height;
    this.mobile = !!options.mobile;
    this.theme = options.theme || null;
    this.hide = options.hide || DEFAULT_HIDE;
    this.random = options.random || Math.random;
    /** Multiplier on every human-paced delay. 0 means "as fast as possible" (used by check). */
    this.pace = options.pace ?? 1;
    this.tape = options.tape || NULL_TAPE;
    this.mouse = { x: Math.round(this.width * 0.62), y: Math.round(this.height * 0.56) };
    this.inflight = new Map();
    this.warnings = [];
    this.pageErrors = [];
    this.injectSource = `window.__demoreelConfig = ${JSON.stringify({ hide: this.hide })};\n${INPAGE_SOURCE}`;
  }

  static async open(connection, options) {
    const session = await connection.newSession();
    const page = new Page(session, options);
    await page.#init();
    return page;
  }

  async #init() {
    const s = this.session;
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    await s.send('Network.enable');
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 0,
      mobile: this.mobile,
    });
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (this.theme) {
      await s.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: this.theme }],
      });
    }
    if (this.mobile) {
      await s.send('Emulation.setUserAgentOverride', {
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      });
    }
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: this.injectSource });
    try {
      await s.connection.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    } catch {
      // Older browsers: downloads simply go to the default folder.
    }

    s.on('Page.javascriptDialogOpening', (params) => {
      this.warnings.push(
        `The page opened a ${params.type} dialog ("${String(params.message).slice(0, 80)}"). It was accepted automatically; native dialogs do not appear in the video.`,
      );
      s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    s.on('Network.requestWillBeSent', (params) => {
      if (params.type === 'WebSocket' || params.type === 'EventSource') return;
      if (/^(data|blob):/.test(params.request.url)) return;
      this.inflight.set(params.requestId, Date.now());
    });
    const done = (params) => this.inflight.delete(params.requestId);
    s.on('Network.loadingFinished', done);
    s.on('Network.loadingFailed', done);
    s.on('Runtime.exceptionThrown', (params) => {
      if (this.pageErrors.length < 5) {
        const details = params.exceptionDetails;
        this.pageErrors.push(String(details.exception?.description || details.text).split('\n')[0].slice(0, 200));
      }
    });
  }

  wait(ms) {
    return sleep(ms * this.pace);
  }

  /** Call a helper inside the page. Returns null if the page is busy navigating. */
  async call(method, ...args) {
    const expression = `(() => { const api = window.__demoreel; if (!api) return { __missing: true }; return api.${method}(...${JSON.stringify(args)}); })()`;
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await this.session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      } catch (error) {
        if (isContextError(error.message)) {
          await sleep(120);
          continue;
        }
        throw error;
      }
      if (response.exceptionDetails) {
        const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
        if (isContextError(text)) {
          await sleep(120);
          continue;
        }
        throw new Error(`In-page helper ${method} failed: ${text}`);
      }
      if (response.result.value && response.result.value.__missing) {
        await this.session.send('Runtime.evaluate', { expression: this.injectSource }).catch(() => {});
        continue;
      }
      return response.result.value ?? null;
    }
    return null;
  }

  /** Run arbitrary JavaScript in the page (the `eval` step). */
  async evaluate(code) {
    const response = await this.session.send('Runtime.evaluate', {
      expression: `(async () => { ${code}\n })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new DemoreelError(`The eval step threw an error: ${String(text).split('\n')[0]}`);
    }
    return response.result.value;
  }

  inflightCount() {
    const cutoff = Date.now() - 6000;
    let count = 0;
    for (const started of this.inflight.values()) if (started > cutoff) count++;
    return count;
  }

  /**
   * Wait until the page stops changing: no requests in flight, no DOM changes,
   * no finite animations. Bounded so a busy page never stalls the video.
   */
  async settle({ min = 250, max = 2600, quiet = 320 } = {}) {
    const start = Date.now();
    const scale = this.pace === 0 ? 0.35 : 1;
    while (true) {
      await sleep(50);
      const elapsed = Date.now() - start;
      if (elapsed >= max * scale) break;
      if (elapsed < min * scale) continue;
      if (this.inflightCount() > 0) continue;
      const state = await this.call('quiet');
      if (!state || !state.ready) continue;
      if (state.sinceMutation < quiet * scale) continue;
      if (state.animating) continue;
      break;
    }
  }

  async goto(url) {
    const loaded = this.session.once('Page.loadEventFired', 30000).catch(() => null);
    let result;
    try {
      result = await this.session.send('Page.navigate', { url });
    } catch (error) {
      throw new DemoreelError(`Could not open ${url}: ${error.message}`);
    }
    if (result.errorText) {
      const refused = /CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE/.test(result.errorText);
      throw new DemoreelError(
        `Could not open ${url} (${result.errorText}).`,
        refused ? 'Is the app running? Start its dev server first, or set "serve" or "start" in the storyboard.' : undefined,
      );
    }
    await loaded;
    await this.settle({ min: 300, max: 5000 });
  }

  async url() {
    const info = await this.call('pageInfo');
    return info?.url || '';
  }

  /**
   * Find an element, waiting for it to appear and stop moving.
   * @returns {Promise<object|null>} null only when `optional` and nothing was found
   */
  async locate(query, { mode = 'click', nth, timeout = 8000, optional = false, action = 'use' } = {}) {
    const deadline = Date.now() + (optional ? Math.min(timeout, 1500) : timeout);
    let previous = null;
    let lastMiss = null;
    let coveredSince = null;
    while (true) {
      const found = await this.call('locate', query, { mode, nth });
      if (found && found.ok) {
        const still =
          previous &&
          Math.abs(previous.rect.x - found.rect.x) < 1 &&
          Math.abs(previous.rect.y - found.rect.y) < 1 &&
          Math.abs(previous.rect.w - found.rect.w) < 1 &&
          Math.abs(previous.rect.h - found.rect.h) < 1;
        if (still && !found.covered) return found;
        if (still && found.covered && !found.needsScroll) {
          coveredSince ??= Date.now();
          if (Date.now() - coveredSince > 1500) {
            this.warnings.push(`"${query}" is covered by ${found.coveredBy}; the ${action} may land on that instead.`);
            return found;
          }
        } else if (still && found.needsScroll) {
          return found;
        }
        previous = found;
      } else {
        previous = null;
        if (found) lastMiss = found;
      }
      if (Date.now() > deadline) break;
      await sleep(previous ? 70 : 130);
    }
    if (previous) return previous;
    if (optional) return null;

    const lines = [];
    if (lastMiss?.close?.length) lines.push(`Did you mean: ${lastMiss.close.map((n) => `"${n}"`).join(', ')}?`);
    if (lastMiss?.visible?.length) lines.push(`On screen now: ${lastMiss.visible.map((n) => `"${n}"`).join(', ')}.`);
    if (!lines.length) lines.push('The page has nothing clickable on screen. Did it finish loading, or is a step missing before this one?');
    throw new DemoreelError(
      `Could not find "${query}" to ${action}. ${lastMiss?.reason || 'Nothing on the page matches.'}`,
      lines.join('\n'),
    );
  }

  /** Bring the last located element into view with a smooth scroll, then find it again. */
  async reveal(query, found, options) {
    if (!found.needsScroll) return found;
    const scrollStart = this.tape.now();
    const result = await this.call('scrollLastIntoView', this.pace === 0 ? 1 : undefined);
    if (result?.scrolled) {
      this.tape.scroll(scrollStart, this.tape.now());
      await this.wait(160);
    }
    return (await this.locate(query, { ...options, timeout: 3000 })) || found;
  }

  async #dispatchMouse(type, x, y, extra = {}) {
    await this.session.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra });
  }

  /** Move the cursor along a natural path, recording where it is at every moment. */
  async moveTo(x, y, { buttons = 0 } = {}) {
    const from = { ...this.mouse };
    const plan = planMove(from, { x, y }, this.random);
    const duration = plan.duration * this.pace;
    const extra = buttons ? { button: 'left', buttons } : {};
    if (duration > 0) {
      const start = Date.now();
      while (true) {
        const progress = (Date.now() - start) / duration;
        if (progress >= 1) break;
        const point = plan.at(progress);
        await this.#dispatchMouse('mouseMoved', point.x, point.y, extra);
        this.tape.cursor(point.x, point.y);
        await sleep(12);
      }
    }
    await this.#dispatchMouse('mouseMoved', x, y, extra);
    this.tape.cursor(x, y);
    this.mouse = { x, y };
    return duration;
  }

  async click(x, y) {
    this.tape.click(x, y);
    await this.#dispatchMouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
    await this.wait(80);
    await this.#dispatchMouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
  }

  async mouseDown(x, y) {
    this.tape.click(x, y);
    await this.#dispatchMouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  }

  async mouseUp(x, y) {
    await this.#dispatchMouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
  }

  async pressKey(combo) {
    const key = parseKeyCombo(combo);
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.vk,
      nativeVirtualKeyCode: key.vk,
      modifiers: key.modifiers,
    };
    await this.session.send('Input.dispatchKeyEvent', {
      ...base,
      type: key.text ? 'keyDown' : 'rawKeyDown',
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
    });
    await this.wait(40);
    await this.session.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  /** Type text one character at a time with a slightly uneven, human rhythm. */
  async typeText(text, { speed = 1 } = {}) {
    for (const char of text) {
      if (char === '\n') {
        await this.pressKey('Enter');
      } else if (char.length === 1 && char >= ' ' && char <= '~') {
        const upper = char.toUpperCase();
        const isLetter = /^[A-Z]$/.test(upper);
        const isDigit = /^[0-9]$/.test(char);
        const base = {
          key: char,
          code: isLetter ? `Key${upper}` : isDigit ? `Digit${char}` : char === ' ' ? 'Space' : '',
          windowsVirtualKeyCode: isLetter || isDigit ? upper.charCodeAt(0) : char === ' ' ? 32 : 0,
          modifiers: isLetter && char === upper ? MODIFIER_BITS.Shift : 0,
        };
        await this.session.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: char, unmodifiedText: char });
        await this.session.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      } else {
        await this.session.send('Input.insertText', { text: char });
      }
      const base = char === ' ' ? 95 : /[.,!?;:]/.test(char) ? 130 : 62;
      await sleep(((base + this.random() * 55) * this.pace) / speed);
    }
  }

  async screenshot() {
    const { data } = await this.session.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }
}
