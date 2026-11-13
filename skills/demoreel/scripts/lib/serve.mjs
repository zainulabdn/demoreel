// Tiny local web servers, bound to 127.0.0.1 only:
//  - a static file server, so a built site can be recorded without a dev server
//  - a helper to start the app's own dev server and wait until it answers

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { DemoreelError, sleep } from './util.mjs';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Resolve a URL path to a file inside `root`, refusing anything that escapes it.
 * @returns {string|null}
 */
export function resolveInside(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = resolve(root);
  const target = resolve(base, `.${normalize(`/${decoded}`)}`);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port));
  });
}

/** Serve a folder of static files. Unknown routes fall back to index.html, like a single-page app host. */
export async function startStaticServer(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new DemoreelError(`"serve" points to ${root}, which is not a folder.`, 'Build the site first, or fix the path.');
  }
  const server = createServer((req, res) => {
    let file = resolveInside(root, req.url || '/');
    if (!file) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) && !extname(file)) {
      const html = `${file}.html`;
      file = existsSync(html) ? html : join(root, 'index.html');
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}

/** True once anything answers at the URL (any HTTP status counts as "up"). */
export function isReachable(url, timeoutMs = 2000) {
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        done(value);
      }
    };
    try {
      const send = url.startsWith('https:') ? httpsRequest : httpRequest;
      const req = send(url, { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
        res.resume();
        finish(true);
      });
      req.on('timeout', () => {
        req.destroy();
        finish(false);
      });
      req.on('error', () => finish(false));
      req.end();
    } catch {
      finish(false);
    }
  });
}

/**
 * Start the app's dev server (for example "npm run dev") and wait until `url` answers.
 * If something already answers at `url`, nothing is started.
 */
export async function startCommand({ command, cwd, timeout }, url) {
  if (await isReachable(url)) return { started: false, close: async () => {} };

  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '';
  const collect = (data) => {
    output = (output + data).slice(-3000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exited = null;
  child.on('exit', (code) => {
    exited = code ?? 1;
  });

  const close = async () => {
    if (exited !== null) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 20 && exited === null; i++) await sleep(100);
  };

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new DemoreelError(
        `The start command "${command}" exited (code ${exited}) before ${url} came up.`,
        output.trim() ? `Last output:\n${output.trim().split('\n').slice(-8).join('\n')}` : undefined,
      );
    }
    if (await isReachable(url)) return { started: true, close };
    await sleep(400);
  }
  await close();
  throw new DemoreelError(
    `${url} did not come up within ${Math.round(timeout / 1000)}s of running "${command}".`,
    'Check that "url" uses the port the dev server actually listens on.',
  );
}
