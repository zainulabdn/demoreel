// The render pass: turn a recording (frames + timeline) into finished files.
// A headless browser tab does the drawing and encoding; this process serves it the
// captured frames over a loopback-only server and receives the finished files back.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';
import { buildPlan } from './plan.mjs';
import { MIME, listen, resolveInside } from './serve.mjs';
import { DemoreelError } from './util.mjs';

const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url));
const STAGE_FILES = new Set(['stage.html', 'stage.js', 'scene.js', 'mp4.js', 'gif.js']);

export function hasFfmpeg() {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function sendFile(res, file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

/**
 * @param {object} options
 * @param {string} options.recordingDir  holds frames/ and timeline.json
 * @param {object} options.timeline
 * @param {object} options.storyboard    normalized storyboard
 * @param {string} [options.chromePath]
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function renderRecording({ recordingDir, timeline, storyboard, chromePath, onProgress = () => {} }) {
  const outDir = storyboard.output.dir;
  mkdirSync(outDir, { recursive: true });

  const plan = buildPlan(timeline, storyboard);
  const ffmpegAvailable = storyboard.output.formats.includes('mp4') && hasFfmpeg();
  plan.encode.sink = ffmpegAvailable;
  writeFileSync(join(recordingDir, 'plan.json'), JSON.stringify(plan));

  const token = randomBytes(12).toString('hex');
  const allowedOutputs = new Set([`${plan.name}.mp4`, `${plan.name}.gif`, `${plan.name}.poster.png`, `${plan.name}.sheet.png`]);
  let ffmpeg = null;
  let ffmpegError = '';

  const server = createServer((req, res) => {
    const prefix = `/${token}/`;
    if (!req.url || !req.url.startsWith(prefix)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const path = req.url.slice(prefix.length).split('?')[0];

    if (req.method === 'GET') {
      if (STAGE_FILES.has(path)) return sendFile(res, join(ASSETS_DIR, path));
      if (path === 'plan.json') return sendFile(res, join(recordingDir, 'plan.json'));
      if (path.startsWith('frames/')) return sendFile(res, resolveInside(join(recordingDir, 'frames'), path.slice('frames/'.length)));
      res.writeHead(404).end('Not found');
      return;
    }

    if (req.method === 'POST' && path.startsWith('out/')) {
      const name = decodeURIComponent(path.slice('out/'.length));
      if (!allowedOutputs.has(name)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const file = join(outDir, name);
      const stream = createWriteStream(file);
      req.pipe(stream);
      stream.on('finish', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: file, bytes: statSync(file).size }));
      });
      stream.on('error', (error) => res.writeHead(500).end(String(error.message)));
      return;
    }

    if (req.method === 'POST' && path === 'sink/frame') {
      if (!ffmpeg) {
        const file = join(outDir, `${plan.name}.mp4`);
        ffmpeg = spawn(
          'ffmpeg',
          ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(plan.fps), '-i', '-',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
          { stdio: ['pipe', 'ignore', 'pipe'] },
        );
        ffmpeg.stderr.on('data', (data) => {
          ffmpegError = (ffmpegError + data).slice(-2000);
        });
        ffmpeg.file = file;
      }
      req.on('data', (chunk) => {
        if (!ffmpeg.stdin.write(chunk)) {
          req.pause();
          ffmpeg.stdin.once('drain', () => req.resume());
        }
      });
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
      return;
    }

    if (req.method === 'POST' && path === 'sink/end') {
      req.resume();
      if (!ffmpeg) {
        res.writeHead(400).end('No frames were sent.');
        return;
      }
      ffmpeg.once('exit', (code) => {
        if (code !== 0) {
          res.writeHead(500).end(`ffmpeg failed: ${ffmpegError}`);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: ffmpeg.file, bytes: statSync(ffmpeg.file).size }));
      });
      ffmpeg.stdin.end();
      return;
    }

    res.writeHead(405).end('Method not allowed');
  });

  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}/${token}/`;
  let browser;
  try {
    browser = await launchChrome({ chromePath, width: 800, height: 600, scale: 1 });
    const session = await browser.connection.newSession();
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', { name: '__demoreelProgress' });
    session.on('Runtime.bindingCalled', (params) => {
      if (params.name !== '__demoreelProgress') return;
      try {
        onProgress(JSON.parse(params.payload));
      } catch {
        // Ignore malformed progress.
      }
    });
    const pageErrors = [];
    session.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
    });

    const loaded = session.once('Page.loadEventFired', 30000);
    await session.send('Page.navigate', { url: `${origin}stage.html` });
    await loaded;
    // The module script may still be starting: wait for the entry point to exist.
    for (let i = 0; i < 100; i++) {
      const ready = await session.send('Runtime.evaluate', { expression: 'typeof window.__demoreelRender', returnByValue: true });
      if (ready.result.value === 'function') break;
      if (i === 99) throw new DemoreelError(`The render page failed to start. ${pageErrors.join(' | ')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const response = await session.send('Runtime.evaluate', {
      expression: 'window.__demoreelRender()',
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new DemoreelError(`Rendering failed: ${String(detail).split('\n')[0]}`);
    }
    const result = response.result.value;
    if (!result?.ok) {
      if (result?.reason === 'no-h264') {
        throw new DemoreelError(
          `${browser.product} cannot encode H.264 video, and ffmpeg is not installed to do it instead.`,
          'Use Google Chrome or Microsoft Edge (pass --chrome /path/to/chrome), or install ffmpeg, or set "output": { "formats": ["gif"] }.',
        );
      }
      throw new DemoreelError(`Rendering failed: ${result?.message || 'unknown error'}`);
    }
    return { ...result, plan, browser: browser.product };
  } finally {
    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    if (browser) await browser.close().catch(() => {});
    await new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    });
  }
}
