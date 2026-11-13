#!/usr/bin/env node
// Demoreel command line. Records a polished demo video of a real web app from a storyboard.
//
//   demoreel record <storyboard.json>   record and render the video
//   demoreel check  <storyboard.json>   run the steps quickly and report what works
//   demoreel render <recording-dir>     re-render a kept recording (new style, no re-recording)
//   demoreel doctor                     check that this machine can record
//   demoreel init   [file]              write a starter storyboard

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { findChrome, launchChrome } from './lib/chrome.mjs';
import { runStoryboard } from './lib/record.mjs';
import { hasFfmpeg, renderRecording } from './lib/render.mjs';
import { listen } from './lib/serve.mjs';
import { loadStoryboard, normalizeStoryboard } from './lib/storyboard.mjs';
import { DemoreelError, formatBytes, formatDuration } from './lib/util.mjs';
import { VERSION } from './lib/version.mjs';

const HELP = `Demoreel ${VERSION} - a polished demo video of your real app, from a storyboard.

Usage
  demoreel record <storyboard.json>   Record the app and render the video
  demoreel check  <storyboard.json>   Run the steps fast, report which work, save a screenshot of each
  demoreel render <recording-dir>     Re-render a recording kept with --keep
  demoreel doctor                     Check that this machine can record
  demoreel init   [file]              Write a starter storyboard (default: demo.reel.json)

Options
  --out <dir>          Where to save the video (default: next to the storyboard)
  --formats <list>     mp4, gif or both, comma separated (default: from the storyboard)
  --keep               Keep the raw recording so it can be re-rendered
  --storyboard <file>  With "render": take style and output settings from this storyboard
  --chrome <path>      Browser to use (default: Chrome, Edge or Brave found on this machine)
  --headed             Show the browser window while recording
  --json               Print a machine-readable summary
  --help, --version
`;

const STARTER = {
  url: 'http://localhost:3000',
  steps: [
    { say: 'Say what the viewer is about to see' },
    { click: 'Get started' },
    { type: 'hello@example.com', into: 'Email' },
    { press: 'Enter' },
    { wait: 800 },
  ],
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const takesValue = new Set(['out', 'formats', 'chrome', 'storyboard']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (takesValue.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new DemoreelError(`--${name} needs a value.`);
      flags[name] = value;
    } else if (['keep', 'headed', 'json', 'help', 'version'].includes(name)) {
      flags[name] = true;
    } else {
      throw new DemoreelError(`Unknown option --${name}.`, 'Run "demoreel --help" to see the options.');
    }
  }
  return { flags, positional };
}

const isTTY = process.stderr.isTTY;
const log = (line = '') => process.stderr.write(`${line}\n`);
const shown = (path) => {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
};

function applyOverrides(storyboard, flags) {
  if (flags.out) storyboard.output.dir = resolve(flags.out);
  if (flags.formats) {
    const formats = flags.formats.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
    if (!formats.length || formats.some((f) => !['mp4', 'gif'].includes(f))) {
      throw new DemoreelError('--formats takes mp4, gif or both, for example --formats mp4,gif.');
    }
    storyboard.output.formats = [...new Set(formats)];
  }
  return storyboard;
}

function stepLogger() {
  return (event) => {
    const number = String(event.step.index + 1).padStart(2, ' ');
    if (event.type === 'done') log(`  ok   ${number}. ${event.step.label}`);
    else if (event.type === 'skipped') log(`  skip ${number}. ${event.step.label} (optional, not found)`);
    else if (event.type === 'failed') log(`  FAIL ${number}. ${event.step.label}`);
  };
}

function progressLogger() {
  let lastPercent = -1;
  return (progress) => {
    if (progress.phase !== 'render') return;
    const percent = Math.floor((progress.done / progress.total) * 100);
    if (isTTY) {
      process.stderr.write(`\r  Rendering ${String(percent).padStart(3)}%  (${progress.done}/${progress.total} frames)`);
      if (progress.done === progress.total) process.stderr.write('\n');
    } else if (percent >= lastPercent + 25 || progress.done === progress.total) {
      log(`  Rendering ${percent}%`);
    }
    lastPercent = percent >= lastPercent + 25 ? percent : lastPercent;
  };
}

function reportProblems(result) {
  for (const warning of result.warnings || []) log(`  Note: ${warning}`);
  if (result.pageErrors?.length) {
    log(`  Note: the page reported ${result.pageErrors.length} JavaScript error(s) while running:`);
    for (const error of result.pageErrors) log(`        ${error}`);
  }
}

async function renderAndReport({ storyboard, timeline, recordingDir, flags, started }) {
  const rendered = await renderRecording({
    recordingDir,
    timeline,
    storyboard,
    chromePath: flags.chrome,
    onProgress: progressLogger(),
  });
  const { layout, fps, durationMs } = rendered.plan;
  log('');
  for (const file of rendered.files) {
    const detail =
      file.kind === 'mp4' ? `${layout.width}x${layout.height}, ${fps} fps, ${formatDuration(durationMs)}`
        : file.kind === 'gif' ? `${rendered.plan.encode.gif.width}x${rendered.plan.encode.gif.height}`
          : file.kind === 'sheet' ? 'contact sheet: one picture per step, for checking the video'
            : 'still image for thumbnails';
    log(`  ${shown(file.path).padEnd(34)} ${formatBytes(file.bytes).padStart(8)}   ${detail}`);
  }
  for (const note of rendered.notes || []) log(`  Note: ${note}`);
  const mp4 = rendered.files.find((file) => file.kind === 'mp4');
  const { maxMB } = rendered.plan.encode;
  if (mp4 && maxMB && mp4.bytes > maxMB * 1_000_000) {
    log(`  Note: the MP4 is larger than the ${maxMB} MB limit. Shorten the video or set "output": { "quality": "small" }.`);
  }
  log(`\n  Done in ${formatDuration(Date.now() - started)}.`);
  return rendered;
}

async function commandRecord(file, flags) {
  if (!file) throw new DemoreelError('Which storyboard? Usage: demoreel record <storyboard.json>');
  const started = Date.now();
  const storyboard = applyOverrides(loadStoryboard(file), flags);
  const recordingDir = join(tmpdir(), 'demoreel', `${storyboard.name}-recording`);
  rmSync(recordingDir, { recursive: true, force: true });
  mkdirSync(recordingDir, { recursive: true });

  log(`Demoreel ${VERSION}`);
  log(`  Recording ${shown(resolve(file))}: ${storyboard.steps.length} steps, ${storyboard.viewport.width}x${storyboard.viewport.height} at ${storyboard.scale}x`);
  let keep = !!flags.keep;
  try {
    const recorded = await runStoryboard(storyboard, {
      mode: 'record',
      workDir: recordingDir,
      chromePath: flags.chrome,
      headed: !!flags.headed,
      onStep: stepLogger(),
    });
    // Saved for "demoreel render". Steps are left out: they are not needed to re-render,
    // and may hold values filled in from environment variables.
    writeFileSync(join(recordingDir, 'storyboard.json'), JSON.stringify({ ...storyboard, steps: [], start: null }));
    log(`  Recorded ${formatDuration(recorded.timeline.duration)} (${recorded.timeline.frames.length} frames) with ${recorded.browser}`);
    reportProblems(recorded);

    const rendered = await renderAndReport({ storyboard, timeline: recorded.timeline, recordingDir, flags, started });
    if (keep) log(`  Raw recording kept at ${recordingDir}`);
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          durationMs: rendered.plan.durationMs,
          files: rendered.files,
          warnings: recorded.warnings,
          pageErrors: recorded.pageErrors,
          recording: keep ? recordingDir : null,
        }, null, 2)}\n`,
      );
    }
  } catch (error) {
    keep = keep || !!error.screenshot;
    throw error;
  } finally {
    if (!keep) rmSync(recordingDir, { recursive: true, force: true });
  }
}

async function commandCheck(file, flags) {
  if (!file) throw new DemoreelError('Which storyboard? Usage: demoreel check <storyboard.json>');
  const storyboard = loadStoryboard(file);
  const workDir = join(tmpdir(), 'demoreel', `${storyboard.name}-check`);
  rmSync(workDir, { recursive: true, force: true });
  log(`Demoreel ${VERSION}`);
  log(`  Checking ${shown(resolve(file))}: ${storyboard.steps.length} steps`);
  try {
    const result = await runStoryboard(storyboard, { mode: 'check', workDir, chromePath: flags.chrome, headed: !!flags.headed, onStep: stepLogger() });
    reportProblems(result);
    log(`\n  All ${storyboard.steps.length} steps work. A screenshot after each step is in ${workDir}`);
    if (flags.json) process.stdout.write(`${JSON.stringify({ ok: true, steps: result.results, warnings: result.warnings, pageErrors: result.pageErrors }, null, 2)}\n`);
  } catch (error) {
    if (flags.json && error.results) {
      process.stdout.write(`${JSON.stringify({ ok: false, steps: error.results, pageErrors: error.pageErrors }, null, 2)}\n`);
    }
    throw error;
  }
}

async function commandRender(dir, flags) {
  if (!dir) throw new DemoreelError('Which recording? Usage: demoreel render <recording-dir>');
  const recordingDir = resolve(dir);
  const timelinePath = join(recordingDir, 'timeline.json');
  const savedStoryboard = join(recordingDir, 'storyboard.json');
  if (!existsSync(timelinePath) || !existsSync(savedStoryboard)) {
    throw new DemoreelError(`${recordingDir} is not a kept recording.`, 'Record with --keep first: demoreel record demo.reel.json --keep');
  }
  const started = Date.now();
  const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
  let storyboard = JSON.parse(readFileSync(savedStoryboard, 'utf8'));
  if (flags.storyboard) {
    const fresh = loadStoryboard(flags.storyboard);
    storyboard = { ...storyboard, name: fresh.name, style: fresh.style, output: fresh.output, displayUrl: fresh.displayUrl };
  }
  applyOverrides(storyboard, flags);
  log(`Demoreel ${VERSION}`);
  log(`  Re-rendering ${recordingDir}`);
  const rendered = await renderAndReport({ storyboard, timeline, recordingDir, flags, started });
  if (flags.json) process.stdout.write(`${JSON.stringify({ ok: true, durationMs: rendered.plan.durationMs, files: rendered.files }, null, 2)}\n`);
}

async function commandDoctor(flags) {
  const lines = [];
  let ok = true;
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`${major >= 20 ? 'ok  ' : 'FAIL'} Node.js ${process.versions.node}${major >= 20 ? '' : ' (20 or newer is required)'}`);
  if (major < 20) ok = false;

  let binary = null;
  try {
    binary = findChrome(flags.chrome);
    lines.push(`ok   Browser found: ${binary}`);
  } catch (error) {
    ok = false;
    lines.push(`FAIL ${error.message}`);
    if (error.hint) lines.push(`     ${error.hint}`);
  }

  let h264 = false;
  if (binary) {
    // WebCodecs only exists on secure origins, and localhost counts as one.
    const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>doctor</title>'));
    const port = await listen(server);
    let browser;
    try {
      browser = await launchChrome({ chromePath: binary, width: 800, height: 600, scale: 1 });
      const session = await browser.connection.newSession();
      await session.send('Page.enable');
      const loaded = session.once('Page.loadEventFired', 15000);
      await session.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      await loaded;
      const response = await session.send('Runtime.evaluate', {
        expression: `(async () => {
          if (typeof VideoEncoder === 'undefined') return false;
          const s = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30, avc: { format: 'avc' } });
          return !!s.supported;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      h264 = response.result.value === true;
      lines.push(`ok   Browser starts headless: ${browser.product}`);
    } catch (error) {
      ok = false;
      lines.push(`FAIL Browser did not start: ${error.message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
      server.close();
      server.closeAllConnections?.();
    }
  }

  const ffmpeg = hasFfmpeg();
  if (binary) {
    if (h264) lines.push('ok   Browser can encode H.264 (MP4 needs nothing else)');
    else if (ffmpeg) lines.push('ok   Browser cannot encode H.264, but ffmpeg is installed and will be used for MP4');
    else {
      lines.push('WARN Browser cannot encode H.264 and ffmpeg is not installed: MP4 is unavailable, GIF still works');
      lines.push('     Use Google Chrome or Microsoft Edge, or install ffmpeg.');
    }
  }
  lines.push(`${ffmpeg ? 'ok  ' : 'info'} ffmpeg ${ffmpeg ? 'found (optional)' : 'not found (optional, only needed if the browser cannot encode H.264)'}`);

  log(`Demoreel ${VERSION} doctor`);
  for (const line of lines) log(`  ${line}`);
  log(ok ? '\n  Ready to record.' : '\n  Not ready: fix the FAIL lines above.');
  if (flags.json) process.stdout.write(`${JSON.stringify({ ok, browser: binary, h264, ffmpeg }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

function commandInit(file = 'demo.reel.json') {
  const target = resolve(file);
  if (existsSync(target)) throw new DemoreelError(`${shown(target)} already exists.`, 'Pick another name, or edit that file.');
  normalizeStoryboard(STARTER, target);
  writeFileSync(target, `${JSON.stringify(STARTER, null, 2)}\n`);
  log(`Wrote ${shown(target)}. Edit the url and steps, then run: demoreel check ${shown(target)}`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command, target] = positional;
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flags.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  switch (command) {
    case 'record': return commandRecord(target, flags);
    case 'check': return commandCheck(target, flags);
    case 'render': return commandRender(target, flags);
    case 'doctor': return commandDoctor(flags);
    case 'init': return commandInit(target);
    default:
      throw new DemoreelError(`Unknown command "${command}".`, 'Commands: record, check, render, doctor, init.');
  }
}

main().catch((error) => {
  if (error instanceof DemoreelError) {
    log(`\nError: ${error.message}`);
    if (error.hint) for (const line of error.hint.split('\n')) log(`  ${line}`);
    if (error.screenshot) log(`  Screenshot of the page at that moment: ${error.screenshot}`);
  } else {
    log(`\nUnexpected error: ${error?.stack || error}`);
  }
  process.exitCode = 1;
});
