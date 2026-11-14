// Turns a recording's timeline plus the storyboard's style into a render plan:
// the exact layout of the picture and, for every output frame, which captured frame
// to show, where the camera looks and where the cursor is. Pure functions: no I/O.

import { buildShots, sampleCamera } from './camera.mjs';
import { cursorAt } from './cursorpath.mjs';
import { buildAudioPlan } from './sound.mjs';
import { clamp } from './util.mjs';

const KIND_INDEX = { default: 0, pointer: 1, text: 2, grab: 3 };

/**
 * Where everything sits in the output picture, in output pixels.
 */
export function computeLayout(output, viewport, style, hasCaptions) {
  const W = output.width;
  const H = output.height;
  const unit = Math.min(W, H);
  const frame = style.frame;
  const bare = frame === 'none';
  const pad = bare ? 0 : Math.round(style.padding * unit);
  // Captions get their own band under the window, so they never cover the app.
  const captionBand = hasCaptions && !bare ? Math.round(0.088 * unit) : 0;
  const padBottom = captionBand ? Math.round(pad * 0.45) : pad;
  const bar = frame === 'browser' ? Math.round(0.043 * unit) : 0;
  const bezel = frame === 'phone' ? Math.round(0.013 * unit) : 0;

  const availableW = W - 2 * pad - 2 * bezel;
  const availableH = H - pad - padBottom - captionBand - bar - 2 * bezel;
  const scale = Math.min(availableW / viewport.width, availableH / viewport.height);
  const contentW = Math.round(viewport.width * scale);
  const contentH = Math.round(viewport.height * scale);

  const windowW = contentW + 2 * bezel;
  const windowH = contentH + bar + 2 * bezel;
  const windowX = Math.round((W - windowW) / 2);
  const windowY = Math.round(pad + (H - pad - padBottom - captionBand - windowH) / 2);

  const k = unit / 1080;
  const radius = bare ? 0 : frame === 'phone' ? Math.round(52 * k) : Math.round(style.radius * k);
  const captionFont = Math.round(0.034 * unit * style.captions.size);
  const captionY = bare
    ? H - Math.round(0.07 * unit) - captionFont
    : windowY + windowH + (H - (windowY + windowH)) / 2;

  return {
    width: W,
    height: H,
    unit: k,
    frame,
    pad,
    window: { x: windowX, y: windowY, w: windowW, h: windowH, radius },
    bar: { h: bar },
    bezel,
    content: { x: windowX + bezel, y: windowY + bar + bezel, w: contentW, h: contentH, scale },
    caption: { cx: W / 2, cy: Math.round(captionY), font: captionFont, maxWidth: W - Math.round(0.16 * W) },
  };
}

/** What to show in the browser bar for a page URL. */
export function displayUrl(url, override) {
  try {
    const parsed = new URL(url);
    const host = override || parsed.host;
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${host}${path}`;
  } catch {
    return override || url;
  }
}

/**
 * Target bitrate for the MP4. Interface video is mostly still, so it needs far fewer bits than
 * camera footage; the presets were chosen by comparing zoomed text at each level. When
 * `maxMB` is set, the target is lowered so the finished file stays under that size
 * (GitHub accepts videos up to 10 MB on free accounts). A sound track takes its share of
 * that size first.
 * @param {number} [audioBitrate]  bits per second used by the sound track, if there is one
 * @returns {{bitrate:number, capped:boolean}}
 */
export function bitrateFor(output, durationMs, audioBitrate = 0) {
  const bitsPerPixel = { high: 0.07, medium: 0.045, small: 0.028 }[output.quality] ?? 0.07;
  const preset = clamp(bitsPerPixel * output.width * output.height * output.fps, 600_000, 40_000_000);
  if (!output.maxMB) return { bitrate: Math.round(preset), capped: false };
  const budget = (output.maxMB * 8_000_000 * 0.9) / Math.max(1, durationMs / 1000) - audioBitrate;
  const bitrate = Math.max(600_000, Math.min(preset, budget));
  return { bitrate: Math.round(bitrate), capped: bitrate < preset };
}

function codecCandidates(output) {
  const pixels = output.width * output.height;
  const fast = output.fps > 30;
  // H.264 level by picture size and frame rate: 4.0 covers 1080p30, 4.2 1080p60, 5.1 up to 4K30.
  let level = '28';
  if (pixels > 1920 * 1088 || (fast && pixels > 1280 * 720)) level = '2a';
  if (pixels > 1920 * 1088) level = fast ? '34' : '33';
  return [`avc1.6400${level}`, `avc1.4d00${level}`, 'avc1.640033', 'avc1.4d0033', 'avc1.640034'];
}

/**
 * Pick the moments shown on the contact sheet: the end of each step (when its result is visible),
 * thinned out evenly if there are more than `max`.
 */
export function sheetMoments(timeline, frameCount, fps, max = 16) {
  const lastFrame = frameCount - 1;
  let moments = (timeline.steps || []).map((step) => ({
    frame: clamp(Math.round((step.t1 * fps) / 1000), 0, lastFrame),
    label: `${step.index + 1}. ${step.label}`,
  }));
  if (!moments.length) moments = [{ frame: 0, label: 'start' }];
  if (moments.length > max - 1) {
    const picked = [];
    for (let i = 0; i < max - 1; i++) picked.push(moments[Math.round((i * (moments.length - 1)) / (max - 2))]);
    moments = picked;
  }
  moments.push({ frame: lastFrame, label: 'end' });
  return moments.map((moment) => ({ ...moment, time: Math.round((moment.frame * 1000) / fps) }));
}

/**
 * How visible the touch dot is in each frame. A finger is only on the glass while it moves
 * or taps, so the dot fades in when a movement starts and fades out shortly after it ends.
 */
export function touchAlpha(timeline, frameCount, fps) {
  // Times when the finger is doing something: stretches of movement, and taps.
  const busy = [];
  const samples = timeline.cursor || [];
  for (let i = 1; i < samples.length; i++) {
    const [t0, x0, y0] = samples[i - 1];
    const [t1, x1, y1] = samples[i];
    if (x0 === x1 && y0 === y1) continue;
    const last = busy[busy.length - 1];
    if (last && t0 <= last[1]) last[1] = t1;
    else busy.push([t0, t1]);
  }
  for (const click of timeline.clicks || []) busy.push([click.t - 60, click.t + 160]);
  busy.sort((a, b) => a[0] - b[0]);

  const alpha = new Array(frameCount);
  let index = 0;
  let lastEnd = -Infinity;
  let level = 0;
  for (let i = 0; i < frameCount; i++) {
    const t = (i * 1000) / fps;
    while (index < busy.length && busy[index][1] < t) lastEnd = Math.max(lastEnd, busy[index++][1]);
    const active = index < busy.length && busy[index][0] <= t;
    const idle = active ? 0 : t - lastEnd;
    const target = idle < 500 ? 1 : Math.max(0, 1 - (idle - 500) / 300);
    level = target > level ? Math.min(target, level + 0.25) : Math.max(target, level - 0.1);
    alpha[i] = Math.round(level * 100) / 100;
  }
  return alpha;
}

/**
 * Build the complete render plan.
 * @param {object} timeline    written by the recording pass
 * @param {object} storyboard  normalized storyboard (style, output, displayUrl, hasCaptions)
 */
export function buildPlan(timeline, storyboard) {
  const { output, style } = storyboard;
  const fps = output.fps;
  const viewport = timeline.viewport;
  const frameCount = Math.max(2, Math.ceil((timeline.duration * fps) / 1000));
  const hasCaptions = (timeline.captions || []).length > 0;
  const layout = computeLayout(output, viewport, style, hasCaptions);

  const durationMs = Math.round((frameCount * 1000) / fps);
  const audio = buildAudioPlan(timeline, storyboard, durationMs);
  const rate = bitrateFor(output, timeline.duration, audio ? audio.bitrate : 0);
  const shots = buildShots(timeline, style);
  const camera = sampleCamera(shots, viewport, frameCount, fps);

  const frames = timeline.frames;
  const src = new Array(frameCount);
  const cursorX = new Array(frameCount);
  const cursorY = new Array(frameCount);
  const cursorKind = new Array(frameCount);
  const press = new Array(frameCount);
  const cursorAlpha = new Array(frameCount);
  const touch = (style.cursor.kind === 'auto' ? viewport.mobile : style.cursor.kind === 'touch') === true;

  let frameIndex = 0;
  let cursorHint = 0;
  let kindIndex = 0;
  let clickIndex = 0;
  const kinds = timeline.cursorKinds || [];
  const clicks = timeline.clicks || [];

  for (let i = 0; i < frameCount; i++) {
    const t = (i * 1000) / fps;
    while (frameIndex + 1 < frames.length && frames[frameIndex + 1].t <= t) frameIndex++;
    src[i] = frameIndex;

    const position = cursorAt(timeline.cursor, t, cursorHint);
    cursorHint = position.index;
    cursorX[i] = Math.round(position.x * 10) / 10;
    cursorY[i] = Math.round(position.y * 10) / 10;

    while (kindIndex + 1 < kinds.length && kinds[kindIndex + 1].t <= t) kindIndex++;
    cursorKind[i] = kinds.length ? KIND_INDEX[kinds[kindIndex].kind] ?? 0 : 0;

    // How far the cursor is "pressed down": dips just before a click and springs back after.
    while (clickIndex + 1 < clicks.length && clicks[clickIndex + 1].t - 90 <= t) clickIndex++;
    let amount = 0;
    if (clicks.length) {
      const dt = t - clicks[clickIndex].t;
      if (dt >= -90 && dt < 0) amount = 1 + dt / 90;
      else if (dt >= 0 && dt <= 190) amount = 1 - dt / 190;
    }
    press[i] = Math.round(amount * 100) / 100;

    cursorAlpha[i] = 1;
  }
  if (touch) {
    const alpha = touchAlpha(timeline, frameCount, fps);
    for (let i = 0; i < frameCount; i++) cursorAlpha[i] = alpha[i];
  }

  return {
    version: 1,
    name: storyboard.name,
    fps,
    frameCount,
    durationMs,
    viewport,
    layout,
    style: {
      background: style.background,
      frame: style.frame,
      shadow: style.shadow,
      chrome: style.chrome,
      cursorSize: style.cursor.size,
      cursorHidden: style.cursor.hidden,
      cursorKind: touch ? 'touch' : 'arrow',
    },
    frames: frames.map((frame) => frame.file),
    track: { src, scale: camera.scale, cx: camera.cx, cy: camera.cy, cursorX, cursorY, cursorKind, press, cursorAlpha },
    clicks,
    captions: timeline.captions || [],
    urls: (timeline.urls || []).map((entry) => ({ t: entry.t, text: displayUrl(entry.url, storyboard.displayUrl) })),
    shots,
    audio,
    sheet: sheetMoments(timeline, frameCount, fps),
    posterFrame: clamp(Math.round(frameCount * 0.45), 0, frameCount - 1),
    encode: {
      formats: output.formats,
      bitrate: rate.bitrate,
      bitrateCapped: rate.capped,
      maxMB: output.maxMB,
      codecs: codecCandidates(output),
      keyframeEvery: fps * 2,
      gif: {
        width: Math.min(output.gif.width, output.width),
        height: Math.round((Math.min(output.gif.width, output.width) * output.height) / output.width / 2) * 2,
        every: Math.max(1, Math.round(fps / output.gif.fps)),
      },
    },
  };
}
