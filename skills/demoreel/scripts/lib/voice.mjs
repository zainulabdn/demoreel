// The voice that speaks the captions. Three ways to get one:
//
//   natural   Kokoro, a free voice model that runs on this computer and sounds like a person.
//             It is not part of Demoreel: "demoreel voice install" downloads it once.
//   system    The voice the computer already has: "say" on macOS, the speech synthesizer on
//             Windows, espeak on Linux. Nothing to install, but it sounds like a computer.
//   command   Any text-to-speech program of your own, given as a command line.
//
// A caption can also name a recorded clip ("audio"), which is used as it is.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { speechBounds } from '../../assets/audio.js';
import { DemoreelError } from './util.mjs';

const KOKORO_SCRIPT = fileURLToPath(new URL('./kokoro_speak.py', import.meta.url));

/** What "voice install" puts on the machine. The checksums make sure the download is the file that was tested. */
export const NATURAL_VOICE = {
  package: 'kokoro-onnx==0.6.1',
  python: { min: [3, 10], max: [3, 13] },
  defaultName: 'af_heart',
  files: [
    {
      name: 'kokoro-v1.0.onnx',
      url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx',
      bytes: 325505369,
      sha256: 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a',
    },
    {
      name: 'voices-v1.0.bin',
      url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin',
      bytes: 28214398,
      sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
    },
  ],
};

const INSTALL_HINT = 'Install it once with: demoreel voice install   (a download of about 400 MB; it then runs on this computer)';

/** Where the natural voice lives. One copy serves every project. */
export function voiceHome(env = process.env) {
  return env.DEMOREEL_VOICE_DIR || join(homedir(), '.demoreel', 'voice');
}

export function naturalVoice(env = process.env) {
  const dir = voiceHome(env);
  const python = join(dir, 'venv', platform() === 'win32' ? 'Scripts' : 'bin', platform() === 'win32' ? 'python.exe' : 'python');
  const [model, voices] = NATURAL_VOICE.files.map((file) => join(dir, file.name));
  return { dir, python, model, voices, installed: existsSync(python) && existsSync(model) && existsSync(voices) };
}

const works = (command, args) => {
  try {
    return spawnSync(command, args, { stdio: 'ignore', timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
};

/** The program that speaks with the computer's own voice, or null if there is none. */
export function systemVoice(plat = platform()) {
  if (plat === 'darwin') return existsSync('/usr/bin/say') ? { tool: 'say' } : null;
  if (plat === 'win32') return works('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']) ? { tool: 'powershell' } : null;
  for (const tool of ['espeak-ng', 'espeak']) if (works(tool, ['--version'])) return { tool };
  return null;
}

/**
 * Decide which voice will really be used.
 * @param {{engine:string, name:string|null, speed:number, command:string|null}} voice  from the storyboard
 * @returns {{engine:'natural'|'system'|'command', name:string|null, speed:number, command:string|null, label:string, note?:string}}
 */
export function resolveVoice(voice, { natural = naturalVoice(), system = systemVoice() } = {}) {
  const noSystem =
    platform() === 'linux'
      ? 'Install espeak-ng (for example: sudo apt install espeak-ng), or get the natural voice.'
      : 'Get the natural voice instead.';
  const useNatural = () => {
    const name = voice.name || NATURAL_VOICE.defaultName;
    return { ...voice, engine: 'natural', name, label: `natural voice "${name}"` };
  };
  const useSystem = () => ({ ...voice, engine: 'system', label: voice.name ? `system voice "${voice.name}"` : 'system voice' });

  if (voice.engine === 'command') return { ...voice, label: 'your own voice command' };
  if (voice.engine === 'natural') {
    if (!natural.installed) throw new DemoreelError('The natural voice is not installed on this computer.', `${INSTALL_HINT}\nOr set "voice": "system" to use the computer's own voice.`);
    return useNatural();
  }
  if (voice.engine === 'system') {
    if (!system) throw new DemoreelError('This computer has no built-in voice.', `${noSystem}\n${INSTALL_HINT}`);
    return useSystem();
  }
  // A name decides the engine when none is given: natural voices are named like "af_heart".
  const naturalName = voice.name && /^[a-z]{2}_[a-z0-9]+$/.test(voice.name);
  if (voice.name && !naturalName && system) return useSystem();
  if (naturalName && !natural.installed) {
    throw new DemoreelError(`"${voice.name}" is a natural voice, and the natural voice is not installed on this computer.`, INSTALL_HINT);
  }
  if (natural.installed) return useNatural();
  if (system) {
    return { ...useSystem(), note: `The computer's built-in voice was used, which sounds like a computer. For a natural voice, run once: demoreel voice install` };
  }
  throw new DemoreelError('There is no voice on this computer to speak the captions.', `${INSTALL_HINT}\n${noSystem}`);
}

/** Run a program, optionally feeding it text, and collect what it prints. */
function run(command, args, { input, env, timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error.message), missing: error.code === 'ENOENT' });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      stderr += `\nStopped after ${Math.round(timeout / 1000)} seconds.`;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (data) => {
      if (stdout.length < 200000) stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error.message), missing: error.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const lastLine = (text) => String(text).trim().split('\n').filter(Boolean).at(-1) || 'no message';

/**
 * Split a command line into its parts the way a shell would, honouring quotes, so the
 * command can be run directly and the spoken words never pass through a shell.
 */
export function splitCommand(command) {
  const parts = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < command.length && '"\\'.includes(command[i + 1])) current += command[++i];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) parts.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new DemoreelError(`The voice command has a quote that is never closed: ${command}`);
  if (started) parts.push(current);
  return parts;
}

/** Replace words with how they should be said ("Demoreel" -> "Demo reel"). Whole words only. */
export function applyPronunciation(text, pronounce = {}) {
  let spoken = text;
  for (const [word, as] of Object.entries(pronounce)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    spoken = spoken.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), as);
  }
  return spoken;
}

/** The voices macOS has, as [{ name, locale }]. */
async function macVoices() {
  const listed = await run('say', ['-v', '?']);
  // Each line: name, language code, then a sample sentence after "#".
  return listed.stdout
    .split('\n')
    .map((line) => /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line))
    .filter(Boolean)
    .map((match) => ({ name: match[1].trim(), locale: match[2] }));
}

/**
 * Stop early when a voice name cannot be right. macOS "say" quietly uses the default voice
 * when it does not know a name, which would put the wrong voice in the video without a word.
 */
export async function checkVoice(voice) {
  if (voice.engine !== 'system' || !voice.name || systemVoice()?.tool !== 'say') return;
  const names = (await macVoices()).map((entry) => entry.name);
  if (names.length && !names.some((name) => name.toLowerCase() === voice.name.toLowerCase())) {
    throw new DemoreelError(`This Mac has no voice called "${voice.name}".`, 'See the names with: demoreel voice');
  }
}

async function speakSystem(lines, voice, tool) {
  for (const line of lines) {
    let result;
    if (tool === 'say') {
      const args = ['-o', line.out, '--file-format=WAVE', '--data-format=LEI16@48000'];
      if (voice.name) args.push('-v', voice.name);
      if (voice.speed !== 1) args.push('-r', String(Math.round(175 * voice.speed)));
      result = await run('say', args, { input: line.text });
    } else if (tool === 'powershell') {
      // The speech rate runs from -10 to 10, where 10 is about three times as fast.
      const rate = Math.max(-10, Math.min(10, Math.round((10 * Math.log(voice.speed)) / Math.log(3))));
      const script = [
        'Add-Type -AssemblyName System.Speech',
        '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        'if ($env:DEMOREEL_VOICE_NAME) { $speaker.SelectVoice($env:DEMOREEL_VOICE_NAME) }',
        '$speaker.Rate = [int]$env:DEMOREEL_VOICE_RATE',
        '$speaker.SetOutputToWaveFile($env:DEMOREEL_VOICE_OUT)',
        '$speaker.Speak([Console]::In.ReadToEnd())',
        '$speaker.Dispose()',
      ].join('; ');
      result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: line.text,
        env: { DEMOREEL_VOICE_NAME: voice.name || '', DEMOREEL_VOICE_RATE: String(rate), DEMOREEL_VOICE_OUT: line.out },
      });
    } else {
      const args = ['-w', line.out, '-s', String(Math.round(175 * voice.speed)), '--stdin'];
      if (voice.name) args.push('-v', voice.name);
      result = await run(tool, args, { input: line.text });
    }
    if (result.code !== 0) {
      throw new DemoreelError(
        `The computer's voice could not speak "${line.text}": ${lastLine(result.stderr)}`,
        voice.name ? `Check that the voice "${voice.name}" exists: demoreel voice` : undefined,
      );
    }
  }
}

async function runKokoro(job) {
  const natural = naturalVoice();
  const jobFile = join(tmpdir(), `demoreel-voice-${process.pid}-${Date.now()}.json`);
  writeFileSync(jobFile, JSON.stringify({ model: natural.model, voices: natural.voices, ...job }));
  try {
    // -I keeps Python from picking up modules from the current folder or the user's settings.
    return await run(natural.python, ['-I', KOKORO_SCRIPT, jobFile]);
  } finally {
    rmSync(jobFile, { force: true });
  }
}

async function speakNatural(lines, voice) {
  const result = await runKokoro({ voice: voice.name, speed: voice.speed, lines });
  if (result.code !== 0) {
    throw new DemoreelError(`The natural voice failed: ${lastLine(result.stderr)}`, 'See the names with: demoreel voice    Reinstall with: demoreel voice install');
  }
}

async function speakCommand(lines, voice) {
  const template = splitCommand(voice.command);
  if (!template.length) throw new DemoreelError('"sound.voice.command" is empty.');
  const takesText = template.some((part) => part.includes('{text}'));
  for (const line of lines) {
    const fill = (part) =>
      part.replaceAll('{out}', line.out).replaceAll('{text}', line.text).replaceAll('{voice}', voice.name || '').replaceAll('{speed}', String(voice.speed));
    const [command, ...args] = template.map(fill);
    const result = await run(command, args, { input: takesText ? '' : line.text });
    if (result.missing) throw new DemoreelError(`The voice command could not start: "${command}" was not found.`);
    if (result.code !== 0) throw new DemoreelError(`The voice command failed for "${line.text}": ${lastLine(result.stderr)}`);
    if (!existsSync(line.out) || statSync(line.out).size === 0) {
      throw new DemoreelError(`The voice command ran, but wrote no sound to {out} for "${line.text}".`, 'It must write a sound file (WAV, MP3 or M4A) to the path given as {out}.');
    }
  }
}

/**
 * Speak lines to sound files.
 * @param {Array<{text:string, out:string}>} lines
 * @param {object} voice  from resolveVoice
 */
export async function synthesize(lines, voice) {
  if (!lines.length) return;
  await checkVoice(voice);
  if (voice.engine === 'natural') await speakNatural(lines, voice);
  else if (voice.engine === 'command') await speakCommand(lines, voice);
  else await speakSystem(lines, voice, systemVoice().tool);
  for (const line of lines) {
    if (!existsSync(line.out) || statSync(line.out).size < 100) throw new DemoreelError(`The voice made no sound for "${line.text}".`);
  }
}

/**
 * Get a sound file for every caption that is spoken, into `<workDir>/audio`.
 * Lines already spoken with the same voice and words are reused, so recording again is quick.
 *
 * @returns {Promise<{clips: Map<number, {file:string, text:string}>, voice: object|null, spoken: number, reused: number, recorded: number}>}
 */
export async function prepareVoice(storyboard, workDir, { cacheDir = join(tmpdir(), 'demoreel', 'voice-cache') } = {}) {
  const clips = new Map();
  const summary = { clips, voice: null, spoken: 0, reused: 0, recorded: 0 };
  const sound = storyboard.sound;
  const lines = storyboard.steps.filter((step) => step.action === 'say' && step.spoken !== undefined);
  if (!sound || !lines.length) return summary;
  const audioDir = join(workDir, 'audio');
  mkdirSync(audioDir, { recursive: true });

  const toSpeak = [];
  for (const step of lines) {
    const base = `voice-${String(step.index + 1).padStart(2, '0')}`;
    if (step.audio) {
      const file = `audio/${base}${extname(step.audio).toLowerCase() || '.wav'}`;
      copyFileSync(step.audio, join(workDir, file));
      clips.set(step.index, { file, text: step.spoken });
      summary.recorded++;
    } else {
      toSpeak.push({ step, file: `audio/${base}.wav`, words: applyPronunciation(step.spoken, sound.pronounce) });
    }
  }
  if (!toSpeak.length) return summary;

  const voice = resolveVoice(sound.voice);
  await checkVoice(voice);
  summary.voice = voice;
  mkdirSync(cacheDir, { recursive: true });
  const missing = [];
  for (const line of toSpeak) {
    const key = createHash('sha256').update(JSON.stringify([voice.engine, voice.name, voice.speed, voice.command, line.words])).digest('hex').slice(0, 32);
    line.cached = join(cacheDir, `${key}.wav`);
    if (existsSync(line.cached) && statSync(line.cached).size > 100) summary.reused++;
    else if (!missing.some((other) => other.cached === line.cached)) missing.push(line);
  }
  // Each new line is spoken to a temporary name first, so an interrupted run leaves nothing half-written behind.
  await synthesize(missing.map((line) => ({ text: line.words, out: `${line.cached}.new.wav` })), voice);
  for (const line of missing) renameSync(`${line.cached}.new.wav`, line.cached);
  for (const line of toSpeak) {
    copyFileSync(line.cached, join(workDir, line.file));
    clips.set(line.step.index, { file: line.file, text: line.step.spoken });
    summary.spoken++;
  }
  return summary;
}

/**
 * Find out how long each clip is and where its speech starts, by decoding it in the browser
 * (which reads WAV, MP3, M4A and more). Voice engines pad their output with silence.
 *
 * @param {import('./chrome.mjs').Connection} connection
 * @param {string} workDir   the folder the clips' "file" paths are relative to
 * @param {Map<number, {file:string, text:string}>} clips
 * @returns {Promise<Map<number, {file:string, text:string, skip:number, duration:number}>>} times in milliseconds
 */
export async function measureClips(connection, workDir, clips) {
  const session = await connection.newSession();
  const measured = new Map();
  for (const [index, clip] of clips) {
    const bytes = readFileSync(join(workDir, clip.file));
    const response = await session.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const speechBounds = ${speechBounds.toString()};
        const binary = atob(${JSON.stringify(bytes.toString('base64'))});
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
        const mono = new Float32Array(buffer.length);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const channel = buffer.getChannelData(c);
          for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels;
        }
        const bounds = speechBounds(mono, 48000);
        return { skip: Math.round(bounds.start / 48), duration: Math.round((bounds.end - bounds.start) / 48) };
      })()`,
    });
    const where = `the spoken line for step ${index + 1} ("${clip.text}")`;
    if (response.exceptionDetails) {
      throw new DemoreelError(`Could not read the sound file for ${where}.`, 'Use a WAV, MP3 or M4A file.');
    }
    const { skip, duration } = response.result.value;
    if (duration < 50) throw new DemoreelError(`The sound file for ${where} is silent.`);
    measured.set(index, { ...clip, skip, duration });
  }
  await session.send('Page.close').catch(() => {});
  return measured;
}

// ---------------------------------------------------------------- installing and listing

/** A Python that the natural voice can run on, as [command, ...arguments], or null. */
export function findPython(env = process.env) {
  const { min, max } = NATURAL_VOICE.python;
  const candidates = [];
  if (env.DEMOREEL_PYTHON) candidates.push([env.DEMOREEL_PYTHON]);
  for (let minor = max[1]; minor >= min[1]; minor--) {
    candidates.push([`python3.${minor}`]);
    if (platform() === 'win32') candidates.push(['py', `-3.${minor}`]);
  }
  candidates.push(['python3'], ['python']);
  for (const [command, ...args] of candidates) {
    try {
      const result = spawnSync(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 15000 });
      if (result.status !== 0) continue;
      const [major, minor] = result.stdout.trim().split('.').map(Number);
      if (major === min[0] && minor >= min[1] && minor <= max[1]) return { command: [command, ...args], version: `${major}.${minor}` };
    } catch {
      // Not installed: try the next name.
    }
  }
  return null;
}

async function download(file, target, log) {
  if (existsSync(target) && statSync(target).size === file.bytes) {
    log(`  ${file.name} is already here`);
    return;
  }
  const megabytes = Math.round(file.bytes / 1e6);
  log(`  Downloading ${file.name} (${megabytes} MB)`);
  const response = await fetch(file.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new DemoreelError(`Could not download ${file.url} (${response.status}).`, 'Check the internet connection and run the command again.');
  const hash = createHash('sha256');
  let received = 0;
  let reported = 0;
  const partial = `${target}.part`;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    const percent = Math.floor((received / file.bytes) * 100);
    if (percent >= reported + 20 && percent < 100) {
      reported = percent - (percent % 20);
      log(`    ${reported}%`);
    }
  });
  await pipeline(body, createWriteStream(partial));
  if (hash.digest('hex') !== file.sha256) {
    rmSync(partial, { force: true });
    throw new DemoreelError(`${file.name} did not download correctly: it is not the file this version was tested with.`, 'Run the command again. If it keeps failing, please open an issue.');
  }
  renameSync(partial, target);
}

/**
 * Download and set up the natural voice. Safe to run again: finished parts are skipped.
 * @param {(line: string) => void} log
 */
export async function installNaturalVoice(log = () => {}) {
  const natural = naturalVoice();
  const python = findPython();
  if (!python) {
    const { min, max } = NATURAL_VOICE.python;
    throw new DemoreelError(
      `The natural voice needs Python ${min.join('.')} to ${max.join('.')}, which was not found.`,
      platform() === 'darwin'
        ? `Install it, for example: brew install python@${max.join('.')}   Then run this command again.`
        : `Install Python ${max.join('.')} from python.org or your package manager, then run this command again.\nIf it is installed under another name, set DEMOREEL_PYTHON to its path.`,
    );
  }
  mkdirSync(natural.dir, { recursive: true });
  log(`  Installing into ${natural.dir} with Python ${python.version}`);
  if (!existsSync(natural.python)) {
    const [command, ...args] = python.command;
    const made = await run(command, [...args, '-m', 'venv', join(natural.dir, 'venv')]);
    if (made.code !== 0) throw new DemoreelError(`Could not create a Python environment: ${lastLine(made.stderr)}`);
  }
  log(`  Installing the voice engine (${NATURAL_VOICE.package})`);
  const installed = await run(natural.python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', NATURAL_VOICE.package], { timeout: 900000 });
  if (installed.code !== 0) throw new DemoreelError(`Could not install the voice engine: ${lastLine(installed.stderr)}`, 'Check the internet connection and run the command again.');
  for (const file of NATURAL_VOICE.files) await download(file, join(natural.dir, file.name), log);

  log('  Checking that it speaks');
  const sample = join(natural.dir, 'check.wav');
  try {
    await speakNatural([{ text: 'Ready.', out: sample }], { name: NATURAL_VOICE.defaultName, speed: 1 });
  } finally {
    rmSync(sample, { force: true });
  }
  return natural;
}

/** The names of the voices on this computer, for "demoreel voice". */
export async function listVoices() {
  const natural = naturalVoice();
  const system = systemVoice();
  const result = { natural: { installed: natural.installed, dir: natural.dir, names: [] }, system: { tool: system?.tool || null, names: [] } };
  if (natural.installed) {
    const listed = await runKokoro({ list: true });
    if (listed.code === 0) {
      try {
        result.natural.names = JSON.parse(lastLine(listed.stdout));
      } catch {
        // Leave the list empty.
      }
    } else {
      result.natural.error = lastLine(listed.stderr);
    }
  }
  if (system?.tool === 'say') {
    result.system.names = (await macVoices()).filter((entry) => entry.locale.startsWith('en')).map((entry) => entry.name);
  } else if (system?.tool === 'powershell') {
    const listed = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }']);
    result.system.names = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }
  return result;
}
