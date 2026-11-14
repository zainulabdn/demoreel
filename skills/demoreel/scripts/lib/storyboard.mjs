// Reads a storyboard (the JSON file that describes a demo) and turns it into a
// fully-specified, validated plan. Every mistake gets a message that says which
// step is wrong and how to fix it, because the usual author is an AI agent.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DemoreelError } from './util.mjs';

export const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  tall: { width: 1280, height: 800 },
  laptop: { width: 1440, height: 900 },
  wide: { width: 1600, height: 900 },
  tablet: { width: 820, height: 1180, mobile: true },
  phone: { width: 390, height: 844, mobile: true, scale: 3 },
};

export const SIZES = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '1440p': { width: 2560, height: 1440 },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  portrait: { width: 1080, height: 1350 },
};

export const FRAMES = ['browser', 'window', 'phone', 'none'];
export const FORMATS = ['mp4', 'gif', 'srt'];
/** Voices that speak the captions: the natural one (after "voice install"), the computer's own, or the best there is. */
export const VOICE_ENGINES = ['auto', 'natural', 'system'];

/** The one key in each step that says what the step does. */
export const ACTIONS = [
  'goto', 'click', 'hover', 'type', 'press', 'scroll', 'wait', 'waitFor', 'say', 'select', 'drag', 'zoom', 'eval',
];

const STEP_OPTIONS = {
  goto: [],
  click: ['nth', 'zoom', 'timeout', 'optional'],
  hover: ['nth', 'zoom', 'timeout', 'optional'],
  type: ['into', 'nth', 'zoom', 'timeout', 'clear', 'speed', 'optional'],
  press: [],
  scroll: ['nth', 'timeout'],
  wait: [],
  waitFor: ['nth', 'timeout'],
  say: ['for', 'speak', 'audio'],
  select: ['in', 'nth', 'zoom', 'timeout'],
  drag: ['to', 'nth', 'timeout'],
  zoom: ['nth', 'timeout', 'level'],
  eval: [],
};
const COMMON_OPTIONS = ['pause', 'note'];

const fail = (message, hint) => {
  throw new DemoreelError(message, hint);
};

/**
 * Replace ${env:NAME} with the value of that environment variable, so test logins and tokens
 * never have to be written into a storyboard file.
 */
export function expandEnv(text, where, env = process.env) {
  return text.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined || env[name] === '') {
      fail(
        `${where} uses \${env:${name}}, but the environment variable ${name} is not set.`,
        `Set it before running, for example: ${name}=... demoreel record demo.reel.json`,
      );
    }
    return env[name];
  });
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkNumber(value, name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be a number.`);
  if (integer && !Number.isInteger(value)) fail(`${name} must be a whole number.`);
  if (value < min || value > max) fail(`${name} must be between ${min} and ${max}.`);
  return value;
}

function describeStep(step) {
  const target = (text) => `"${String(text).length > 40 ? `${String(text).slice(0, 37)}...` : text}"`;
  switch (step.action) {
    case 'goto': return `goto ${step.url}`;
    case 'click': return `click ${target(step.target)}`;
    case 'hover': return `hover ${target(step.target)}`;
    case 'type': return step.target ? `type ${target(step.text)} into ${target(step.target)}` : `type ${target(step.text)}`;
    case 'press': return `press ${step.key}`;
    case 'scroll': return `scroll ${typeof step.amount === 'number' ? `${step.amount}px` : step.amount ?? target(step.target)}`;
    case 'wait': return `wait ${step.ms}ms`;
    case 'waitFor': return `wait for ${target(step.target)}`;
    case 'say': return step.text ? `say ${target(step.text)}` : 'clear caption';
    case 'select': return `select ${target(step.option)} in ${target(step.target)}`;
    case 'drag': return `drag ${target(step.target)} to ${target(step.to)}`;
    case 'zoom': return step.out ? 'zoom out' : `zoom to ${target(step.target)}`;
    case 'eval': return 'run script';
    default: return step.action;
  }
}

function normalizeStep(raw, index) {
  const where = `Step ${index + 1}`;
  if (!isObject(raw)) {
    fail(`${where} must be an object such as { "click": "Sign in" }.`);
  }
  const present = ACTIONS.filter((action) => action in raw);
  // "zoom" doubles as an option on other steps ({ "click": "Save", "zoom": false }).
  const actions = present.length > 1 ? present.filter((action) => action !== 'zoom') : present;
  if (actions.length === 0) {
    fail(`${where} has no action.`, `Each step needs exactly one of: ${ACTIONS.join(', ')}.`);
  }
  if (actions.length > 1) {
    fail(`${where} has more than one action (${actions.join(', ')}).`, 'Split it into separate steps.');
  }
  const action = actions[0];
  const value = raw[action];
  const allowed = new Set([action, ...STEP_OPTIONS[action], ...COMMON_OPTIONS]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      fail(
        `${where} (${action}) has an option it does not understand: "${key}".`,
        `Options for ${action}: ${[...STEP_OPTIONS[action], ...COMMON_OPTIONS].join(', ') || 'none'}.`,
      );
    }
  }

  const step = { index, action };
  const needText = (text, name = action) => {
    if (typeof text !== 'string' || !text.trim()) fail(`${where}: "${name}" needs some text.`);
    return text;
  };

  switch (action) {
    case 'goto':
      step.url = needText(value);
      break;
    case 'click':
    case 'hover':
    case 'waitFor':
      step.target = needText(value);
      break;
    case 'type':
      if (typeof value !== 'string' || value === '') fail(`${where}: "type" needs the text to type.`);
      step.text = value;
      if ('into' in raw) step.target = needText(raw.into, 'into');
      step.clear = raw.clear === true;
      step.speed = 'speed' in raw ? checkNumber(raw.speed, `${where}: speed`, { min: 0.2, max: 10 }) : 1;
      break;
    case 'press':
      step.key = needText(value);
      break;
    case 'scroll':
      if (typeof value === 'number') step.amount = checkNumber(value, `${where}: scroll`);
      else if (value === 'top' || value === 'bottom') step.amount = value;
      else step.target = needText(value);
      break;
    case 'wait':
      step.ms = checkNumber(value, `${where}: wait`, { min: 0, max: 60000 });
      break;
    case 'say':
      if (typeof value !== 'string') fail(`${where}: "say" needs caption text (or "" to clear the caption).`);
      step.text = value.trim();
      if ('for' in raw) step.duration = checkNumber(raw.for, `${where}: for`, { min: 200, max: 60000 });
      if ('speak' in raw) {
        if (raw.speak === false) step.speak = false;
        else if (typeof raw.speak === 'string' && raw.speak.trim()) step.speak = raw.speak.trim();
        else fail(`${where}: "speak" needs the words to say out loud, or false to keep this caption silent.`);
      }
      if ('audio' in raw) {
        if (step.speak === false) fail(`${where} has both "audio" and "speak": false.`, 'Remove one of them.');
        step.audio = needText(raw.audio, 'audio');
      }
      break;
    case 'select':
      step.option = needText(value);
      step.target = needText(raw.in, 'in');
      break;
    case 'drag':
      step.target = needText(value);
      step.to = needText(raw.to, 'to');
      break;
    case 'zoom':
      if (value === 'out' || value === false) step.out = true;
      else step.target = needText(value);
      if ('level' in raw) step.level = checkNumber(raw.level, `${where}: level`, { min: 1, max: 4 });
      break;
    case 'eval':
      step.code = needText(value);
      break;
    default:
      break;
  }

  if ('nth' in raw) step.nth = checkNumber(raw.nth, `${where}: nth`, { min: 1, max: 999, integer: true });
  if ('timeout' in raw) step.timeout = checkNumber(raw.timeout, `${where}: timeout`, { min: 100, max: 120000 });
  if ('pause' in raw) step.pause = checkNumber(raw.pause, `${where}: pause`, { min: 0, max: 60000 });
  if ('optional' in raw) step.optional = raw.optional === true;
  if (action !== 'zoom' && 'zoom' in raw) {
    if (raw.zoom === false) step.zoom = false;
    else if (raw.zoom === true) step.zoom = undefined;
    else step.zoom = checkNumber(raw.zoom, `${where}: zoom`, { min: 1, max: 4 });
  }
  // The label is made from the text as written, so secrets from ${env:...} never reach logs,
  // the contact sheet or the saved timeline. Only then are the real values filled in.
  step.label = describeStep(step);
  for (const key of ['text', 'url', 'code', 'speak']) {
    if (typeof step[key] === 'string') step[key] = expandEnv(step[key], where);
  }
  return step;
}

function normalizeVoice(raw) {
  const voice = { engine: 'auto', name: null, speed: 1, command: null };
  const engineOf = (value) => {
    const engine = value === 'kokoro' ? 'natural' : value;
    if (!VOICE_ENGINES.includes(engine)) {
      fail(`Unknown voice "${value}".`, `Use true, or one of: ${VOICE_ENGINES.join(', ')}, or { "engine", "name", "speed" }.`);
    }
    return engine;
  };
  if (raw === undefined || raw === false || raw === null) return null;
  if (raw === true) return voice;
  if (typeof raw === 'string') return { ...voice, engine: engineOf(raw) };
  if (!isObject(raw)) fail('"sound.voice" must be true, a voice engine name, or an object.');
  const known = ['engine', 'name', 'speed', 'command'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) fail(`"sound.voice.${key}" is not a voice option.`, `Voice options: ${known.join(', ')}.`);
  }
  if ('command' in raw) {
    if (typeof raw.command !== 'string' || !raw.command.includes('{out}')) {
      fail('"sound.voice.command" must be a command that writes a sound file to {out}.', 'For example: "piper --model en.onnx --output_file {out}". The words arrive on standard input, or where you write {text}.');
    }
    if ('engine' in raw && raw.engine !== 'command') fail('"sound.voice" has both "command" and "engine".', 'Remove one of them.');
    voice.engine = 'command';
    voice.command = raw.command;
  } else if ('engine' in raw) {
    voice.engine = engineOf(raw.engine);
  }
  if ('name' in raw) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) fail('"sound.voice.name" must be the name of a voice.', 'Run "demoreel voice" to see the names.');
    voice.name = raw.name.trim();
  }
  if ('speed' in raw) voice.speed = checkNumber(raw.speed, 'sound.voice.speed', { min: 0.5, max: 2 });
  return voice;
}

/** A volume setting: true is the designed level, false is off, a number scales it. */
function normalizeVolume(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (raw === true) return 1;
  if (raw === false) return 0;
  if (isObject(raw)) return 'volume' in raw ? checkNumber(raw.volume, `${name}.volume`, { min: 0, max: 3 }) : 1;
  return checkNumber(raw, name, { min: 0, max: 3 });
}

/** Resolve a sound file named in the storyboard, and say so plainly if it is not there. */
function soundFile(path, name, dir) {
  const file = resolve(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail(`${name} points to ${path}, which does not exist.`, `Looked for ${file}. Paths are relative to the storyboard file.`);
  }
  return file;
}

/**
 * The "sound" option: a voice that speaks the captions, click and typing sounds, and music.
 * Returns null when the video is silent.
 */
function normalizeSound(raw, dir, steps) {
  const clips = steps.some((step) => step.audio);
  // A storyboard that gives a recorded clip for a caption wants sound, even if it does not say so.
  if (raw === undefined && clips) raw = {};
  if (raw === undefined || raw === false || raw === null) return null;
  if (raw === true) raw = { voice: true };
  if (!isObject(raw)) fail('"sound" must be true or an object such as { "voice": true, "music": "./music.mp3" }.');
  const known = ['voice', 'effects', 'music', 'pronounce'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) fail(`"sound.${key}" is not a sound option.`, `Sound options: ${known.join(', ')}.`);
  }

  let music = null;
  if (typeof raw.music === 'string') music = { file: soundFile(raw.music, '"sound.music"', dir), volume: 1 };
  else if (isObject(raw.music)) {
    if (typeof raw.music.file !== 'string') fail('"sound.music" needs a "file", for example { "file": "./music.mp3", "volume": 0.8 }.');
    music = { file: soundFile(raw.music.file, '"sound.music.file"', dir), volume: normalizeVolume(raw.music.volume, 'sound.music.volume', 1) };
  } else if (raw.music !== undefined && raw.music !== false && raw.music !== null) {
    fail('"sound.music" must be the path of a sound file, or { "file", "volume" }.');
  }
  if (music && music.volume === 0) music = null;

  const pronounce = {};
  if (raw.pronounce !== undefined) {
    if (!isObject(raw.pronounce) || Object.entries(raw.pronounce).some(([word, spoken]) => !word.trim() || typeof spoken !== 'string' || !spoken.trim())) {
      fail('"sound.pronounce" must map words to how they are said, for example { "Demoreel": "Demo reel" }.');
    }
    for (const [word, spoken] of Object.entries(raw.pronounce)) pronounce[word.trim()] = spoken.trim();
  }

  const sound = {
    voice: normalizeVoice(raw.voice),
    effects: normalizeVolume(raw.effects, 'sound.effects', 1),
    music,
    pronounce,
  };
  return sound.voice || sound.effects > 0 || sound.music || clips ? sound : null;
}

function normalizeViewport(raw) {
  if (raw === undefined) return { ...VIEWPORTS.desktop, mobile: false };
  if (typeof raw === 'string') {
    const preset = VIEWPORTS[raw];
    if (!preset) fail(`Unknown viewport "${raw}".`, `Use one of: ${Object.keys(VIEWPORTS).join(', ')}, or { "width": 1280, "height": 800 }.`);
    return { mobile: false, ...preset };
  }
  if (!isObject(raw)) fail('"viewport" must be a preset name or { "width", "height" }.');
  return {
    width: checkNumber(raw.width, 'viewport.width', { min: 320, max: 3840, integer: true }),
    height: checkNumber(raw.height, 'viewport.height', { min: 320, max: 2400, integer: true }),
    mobile: raw.mobile === true,
    ...(raw.scale ? { scale: checkNumber(raw.scale, 'viewport.scale', { min: 1, max: 4 }) } : {}),
  };
}

function normalizeOutput(raw = {}, storyboardDir) {
  if (!isObject(raw)) fail('"output" must be an object.');
  let size = SIZES['1080p'];
  if (typeof raw.size === 'string') {
    size = SIZES[raw.size];
    if (!size) fail(`Unknown output size "${raw.size}".`, `Use one of: ${Object.keys(SIZES).join(', ')}, or { "width", "height" }.`);
  } else if (isObject(raw.size)) {
    size = {
      width: checkNumber(raw.size.width, 'output.size.width', { min: 320, max: 3840, integer: true }),
      height: checkNumber(raw.size.height, 'output.size.height', { min: 320, max: 3840, integer: true }),
    };
  } else if (raw.size !== undefined) {
    fail('"output.size" must be a preset name or { "width", "height" }.');
  }
  // H.264 needs even dimensions.
  size = { width: size.width - (size.width % 2), height: size.height - (size.height % 2) };

  const fps = raw.fps ?? 30;
  if (![24, 25, 30, 50, 60].includes(fps)) fail('"output.fps" must be 24, 25, 30, 50 or 60.');

  const formats = raw.formats ?? ['mp4', 'gif'];
  if (!Array.isArray(formats) || !formats.length || formats.some((f) => !FORMATS.includes(f))) {
    fail(`"output.formats" must be a list with any of: ${FORMATS.join(', ')}.`);
  }

  const gif = isObject(raw.gif) ? raw.gif : {};
  const quality = raw.quality ?? 'high';
  if (!['high', 'medium', 'small'].includes(quality)) fail('"output.quality" must be "high", "medium" or "small".');

  return {
    ...size,
    fps,
    formats: [...new Set(formats)],
    quality,
    maxMB: 'maxMB' in raw ? (raw.maxMB === false ? 0 : checkNumber(raw.maxMB, 'output.maxMB', { min: 0, max: 4000 })) : 9.5,
    dir: resolve(storyboardDir, typeof raw.dir === 'string' ? raw.dir : '.'),
    gif: {
      // Tall videos get a narrower GIF by default, or the file becomes enormous.
      width: 'width' in gif
        ? checkNumber(gif.width, 'output.gif.width', { min: 240, max: 1920, integer: true })
        : size.width >= size.height ? 960 : 540,
      fps: 'fps' in gif ? checkNumber(gif.fps, 'output.gif.fps', { min: 5, max: 30 }) : 15,
    },
  };
}

function cursorKind(value) {
  if (value === undefined) return 'auto';
  if (!['auto', 'arrow', 'touch'].includes(value)) fail('"style.cursor.kind" must be "auto", "arrow" or "touch".');
  return value;
}

function normalizeStyle(raw = {}, viewport) {
  if (!isObject(raw)) fail('"style" must be an object.');
  const known = ['background', 'frame', 'zoom', 'padding', 'radius', 'shadow', 'cursor', 'captions', 'chrome'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) fail(`"style.${key}" is not a style option.`, `Style options: ${known.join(', ')}.`);
  }
  const portrait = viewport.height > viewport.width;
  const frame = raw.frame ?? (portrait && viewport.mobile ? 'phone' : 'browser');
  if (!FRAMES.includes(frame)) fail(`Unknown frame "${raw.frame}".`, `Use one of: ${FRAMES.join(', ')}.`);

  let background = raw.background ?? 'dusk';
  if (Array.isArray(background)) {
    if (background.length < 2 || background.some((c) => typeof c !== 'string')) {
      fail('"style.background" as a list needs two or more colors, for example ["#0f172a", "#7c3aed"].');
    }
  } else if (typeof background !== 'string') {
    fail('"style.background" must be a preset name, a color, or a list of colors.');
  }

  const cursor = isObject(raw.cursor) ? raw.cursor : {};
  const captions = isObject(raw.captions) ? raw.captions : {};
  return {
    background,
    frame,
    zoom: 'zoom' in raw ? (raw.zoom === false ? 1 : checkNumber(raw.zoom, 'style.zoom', { min: 1, max: 4 })) : 1.6,
    padding: 'padding' in raw ? checkNumber(raw.padding, 'style.padding', { min: 0, max: 0.3 }) : 0.06,
    radius: 'radius' in raw ? checkNumber(raw.radius, 'style.radius', { min: 0, max: 80 }) : 14,
    shadow: raw.shadow !== false,
    chrome: ['auto', 'light', 'dark'].includes(raw.chrome) ? raw.chrome : 'auto',
    cursor: {
      size: 'size' in cursor ? checkNumber(cursor.size, 'style.cursor.size', { min: 0.5, max: 4 }) : 1,
      hidden: cursor.hidden === true,
      kind: cursorKind(cursor.kind),
    },
    captions: {
      size: 'size' in captions ? checkNumber(captions.size, 'style.captions.size', { min: 0.5, max: 3 }) : 1,
    },
  };
}

/**
 * Validate a parsed storyboard object and fill in every default.
 * @param {object} raw           parsed JSON
 * @param {string} [filePath]    where it came from, for relative paths and the default name
 */
export function normalizeStoryboard(raw, filePath = 'demo.reel.json') {
  if (!isObject(raw)) fail('The storyboard must be a JSON object with "url" and "steps".');
  const known = ['$schema', 'name', 'url', 'serve', 'start', 'viewport', 'scale', 'theme', 'pace', 'hide', 'displayUrl', 'output', 'style', 'sound', 'steps', 'seed'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) fail(`"${key}" is not a storyboard option.`, `Top-level options: ${known.filter((k) => k !== '$schema').join(', ')}.`);
  }
  const dir = dirname(resolve(filePath));

  if (raw.serve !== undefined && typeof raw.serve !== 'string') fail('"serve" must be a folder path, for example "./dist".');
  if (raw.url !== undefined && typeof raw.url !== 'string') fail('"url" must be a string.');
  if (!raw.url && !raw.serve) {
    fail('The storyboard needs a "url" to open.', 'Add "url": "http://localhost:3000", or "serve": "./dist" for a static site.');
  }
  if (raw.url && !raw.serve && !/^https?:\/\//.test(raw.url)) {
    fail(`"url" must start with http:// or https:// (got "${raw.url}").`);
  }

  let start = null;
  if (raw.start !== undefined) {
    const command = typeof raw.start === 'string' ? raw.start : raw.start?.command;
    if (typeof command !== 'string' || !command.trim()) fail('"start" needs a command, for example "npm run dev".');
    start = {
      command,
      cwd: resolve(dir, (isObject(raw.start) && raw.start.cwd) || '.'),
      timeout: isObject(raw.start) && raw.start.timeout ? checkNumber(raw.start.timeout, 'start.timeout', { min: 1000, max: 600000 }) : 60000,
    };
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    fail('The storyboard needs a "steps" list with at least one step.');
  }
  const steps = raw.steps.map(normalizeStep);
  for (const step of steps) {
    if (step.audio) step.audio = soundFile(step.audio, `Step ${step.index + 1}: "audio"`, dir);
  }
  const sound = normalizeSound(raw.sound, dir, steps);
  // Which captions are spoken, and with which words: a recorded clip, the "speak" text, or the caption itself.
  for (const step of steps) {
    if (step.action !== 'say') continue;
    const words = step.speak === false ? '' : step.speak || step.text;
    if (sound && (step.audio || (sound.voice && words))) step.spoken = words || step.text;
    else if (typeof step.speak === 'string' || step.audio) {
      fail(
        `Step ${step.index + 1} has "${step.audio ? 'audio' : 'speak'}", but the storyboard has no voice.`,
        'Add "sound": { "voice": true } at the top level, or remove it from the step.',
      );
    }
  }

  const viewport = normalizeViewport(raw.viewport);
  const scale = raw.scale !== undefined ? checkNumber(raw.scale, 'scale', { min: 1, max: 4 }) : viewport.scale ?? 2;
  if (raw.theme !== undefined && !['light', 'dark'].includes(raw.theme)) fail('"theme" must be "light" or "dark".');
  if (raw.hide !== undefined && (!Array.isArray(raw.hide) || raw.hide.some((s) => typeof s !== 'string'))) {
    fail('"hide" must be a list of CSS selectors.');
  }

  const fileBase = basename(filePath).replace(/(\.reel)?\.json$/i, '') || 'demo';
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().replace(/[^\w.-]+/g, '-') : fileBase;

  return {
    name,
    dir,
    url: raw.url ? expandEnv(raw.url, '"url"') : '/',
    serve: raw.serve ? resolve(dir, raw.serve) : null,
    start,
    viewport: { width: viewport.width, height: viewport.height, mobile: !!viewport.mobile },
    scale,
    theme: raw.theme || null,
    pace: raw.pace !== undefined ? checkNumber(raw.pace, 'pace', { min: 0.25, max: 4 }) : 1,
    hide: raw.hide || [],
    displayUrl: typeof raw.displayUrl === 'string' ? raw.displayUrl : null,
    seed: typeof raw.seed === 'number' ? raw.seed : null,
    output: normalizeOutput(raw.output, dir),
    style: normalizeStyle(raw.style, viewport),
    sound,
    steps,
    hasCaptions: steps.some((step) => step.action === 'say' && step.text),
  };
}

/** Read and validate a storyboard file. */
export function loadStoryboard(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new DemoreelError(`Cannot read the storyboard at ${filePath}.`, 'Check the path, or create one with: demoreel init');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DemoreelError(`${filePath} is not valid JSON: ${error.message}`);
  }
  return normalizeStoryboard(raw, filePath);
}
