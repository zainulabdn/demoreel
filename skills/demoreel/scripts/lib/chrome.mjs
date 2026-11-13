// Finds a Chromium-based browser on this machine, launches it headless, and talks to it
// over the Chrome DevTools Protocol using a private pipe (no network port is opened).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoreelError } from './util.mjs';

/**
 * Ordered list of places a usable browser might live.
 * Branded Chrome and Edge come first because they ship an H.264 encoder.
 */
export function chromeCandidates(env = process.env, plat = platform(), home = homedir()) {
  const list = [];
  const add = (path) => {
    if (path && !list.includes(path)) list.push(path);
  };
  add(env.DEMOREEL_CHROME);
  add(env.CHROME_PATH);

  if (plat === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const app of apps) {
      add(join('/Applications', app));
      add(join(home, 'Applications', app));
    }
  } else if (plat === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const apps = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    for (const app of apps) for (const root of roots) add(`${root}\\${app}`);
  } else {
    const names = [
      'google-chrome-stable',
      'google-chrome',
      'microsoft-edge-stable',
      'microsoft-edge',
      'brave-browser',
      'chromium',
      'chromium-browser',
    ];
    const dirs = (env.PATH || '').split(':').filter(Boolean);
    for (const name of names) for (const dir of dirs) add(join(dir, name));
    add('/snap/bin/chromium');
  }
  return list;
}

/** @returns {string} path to a browser binary */
export function findChrome(explicit, { exists = existsSync } = {}) {
  if (explicit) {
    if (!exists(explicit)) {
      throw new DemoreelError(`No browser found at ${explicit}`, 'Check the --chrome path.');
    }
    return explicit;
  }
  const found = chromeCandidates().find((path) => exists(path));
  if (!found) {
    throw new DemoreelError(
      'Could not find Chrome, Edge or Brave on this machine.',
      'Install Google Chrome, or pass its location with --chrome /path/to/chrome (or set CHROME_PATH).',
    );
  }
  return found;
}

/** One CDP connection to the browser. Sessions (tabs) share the connection. */
export class Connection {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, method: string}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    this.closed = false;
    this.writer = proc.stdio[3];
    this.reader = proc.stdio[4];
    this.chunks = [];

    this.reader.on('data', (data) => this.#onData(data));
    this.reader.on('error', () => {});
    this.writer.on('error', () => {});
    proc.on('exit', () => this.#onExit());
  }

  #onData(data) {
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0) continue;
      this.chunks.push(data.subarray(start, i));
      const text = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      start = i + 1;
      if (text) this.#onMessage(text);
    }
    if (start < data.length) this.chunks.push(data.subarray(start));
  }

  #onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(`${entry.method}: ${message.error.message}`);
        error.cdp = message.error;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    const set = this.handlers.get(`${message.sessionId || ''}|${message.method}`);
    if (set) for (const handler of [...set]) handler(message.params || {});
  }

  #onExit() {
    this.closed = true;
    for (const entry of this.pending.values()) {
      entry.reject(new DemoreelError('The browser closed unexpectedly.'));
    }
    this.pending.clear();
  }

  /** Send a CDP command. */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new DemoreelError('The browser is not running.'));
    const id = this.nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.writer.write(`${JSON.stringify(payload)}\0`);
    });
  }

  /** Listen for a CDP event. Returns a function that removes the listener. */
  on(method, handler, sessionId) {
    const key = `${sessionId || ''}|${method}`;
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key).add(handler);
    return () => this.handlers.get(key)?.delete(handler);
  }

  /** Open a new tab and return a session bound to it. */
  async newSession(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(this, sessionId, targetId);
  }
}

/** A CDP session attached to one tab. */
export class Session {
  constructor(connection, sessionId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  on(method, handler) {
    return this.connection.on(method, handler, this.sessionId);
  }

  /** Resolve the next time an event fires, or reject after a timeout. */
  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  async close() {
    try {
      await this.connection.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      // The tab may already be gone.
    }
  }
}

/**
 * Launch a browser for recording or rendering.
 * @param {object} options
 * @param {string} [options.chromePath]
 * @param {number} options.width  viewport width in CSS pixels
 * @param {number} options.height viewport height in CSS pixels
 * @param {number} [options.scale] device pixel ratio, so frames are captured sharp
 * @param {boolean} [options.headed] show the browser window (for debugging)
 */
export async function launchChrome({ chromePath, width, height, scale = 2, headed = false }) {
  const binary = findChrome(chromePath);
  const profileDir = mkdtempSync(join(tmpdir(), 'demoreel-profile-'));
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--autoplay-policy=no-user-gesture-required',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`,
  ];
  if (!headed) args.unshift('--headless=new');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot || process.env.DEMOREEL_NO_SANDBOX === '1') args.push('--no-sandbox');
  args.push('about:blank');

  const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (data) => {
    if (stderr.length < 8000) stderr += data;
  });

  const connection = new Connection(proc);
  const cleanup = () => {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort: the OS clears temp files eventually.
    }
  };

  let startupTimer;
  try {
    const started = await Promise.race([
      connection.send('Browser.getVersion'),
      new Promise((_, reject) => proc.once('error', reject)),
      new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('The browser did not respond within 20 seconds.')), 20000);
      }),
    ]);
    clearTimeout(startupTimer);
    return {
      connection,
      binary,
      product: started.product,
      async close() {
        if (!connection.closed) {
          try {
            await Promise.race([connection.send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]);
          } catch {
            // Already closing.
          }
        }
        if (proc.exitCode === null) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              proc.kill('SIGKILL');
              resolve();
            }, 2500);
            proc.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        cleanup();
      },
    };
  } catch (error) {
    clearTimeout(startupTimer);
    proc.kill('SIGKILL');
    cleanup();
    throw new DemoreelError(
      `Could not start the browser at ${binary}: ${error.message}`,
      stderr.trim() ? `Browser output: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : undefined,
    );
  }
}
