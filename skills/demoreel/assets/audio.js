// Builds the soundtrack of a video: spoken lines, click and typing sounds, and music that
// steps back while someone is speaking. Everything here is plain arithmetic on arrays of
// samples, so it runs the same in the browser (where the video is rendered) and in Node
// (where it is tested). No dependencies.

export const SAMPLE_RATE = 48000;

/** How loud the finished soundtrack is, in LUFS. -16 is what phones and social sites expect. */
export const TARGET_LUFS = -16;

/** The loudest a sample may be (-1 dBFS), which leaves room for the AAC encoder's overshoot. */
export const CEILING = 0.891;

const TAU = Math.PI * 2;
const fromDb = (db) => Math.pow(10, db / 20);
const toDb = (ratio) => 20 * Math.log10(Math.max(ratio, 1e-12));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Deterministic random numbers (mulberry32), so the same recording always sounds the same. */
export function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- sound effects

/** Scale a sound so its loudest sample is exactly 1. */
function normalizePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] /= peak;
  return samples;
}

/**
 * A short burst of noise kept between two frequencies, over a low thump. Together they
 * make the "tick" of a mouse button or the softer "thock" of a key.
 */
function tap({ rate, random, seconds, bright, dark, tickDecay, thumpHz, thumpDecay, thumpLevel }) {
  const out = new Float32Array(Math.round(seconds * rate));
  // One-pole filters: "low" removes what is above `bright`, "lower" tracks what is below `dark`.
  const a = 1 - Math.exp((-TAU * bright) / rate);
  const b = 1 - Math.exp((-TAU * dark) / rate);
  let low = 0;
  let lower = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    low += a * (random() * 2 - 1 - low);
    lower += b * (low - lower);
    const tick = (low - lower) * Math.exp(-t / tickDecay);
    const thump = thumpLevel * Math.sin(TAU * thumpHz * t) * Math.exp(-t / thumpDecay);
    // A 1 ms fade-in keeps the very first sample from being a click of its own.
    out[i] = (tick * 1.7 + thump) * Math.min(1, t / 0.001);
  }
  return normalizePeak(out);
}

/** A mouse click: brighter and shorter than a key. Loudest sample is 1. */
export function clickSound(rate = SAMPLE_RATE, random = seededNoise(1)) {
  return tap({ rate, random, seconds: 0.05, bright: 6500, dark: 1400, tickDecay: 0.0035, thumpHz: 210 + random() * 30, thumpDecay: 0.009, thumpLevel: 0.45 });
}

/**
 * One key press. `kind` is "char" for a letter, "space", "enter", or "key" for a shortcut.
 * Every key is pitched a little differently, the way a real keyboard sounds. Loudest sample is 1.
 */
export function keySound(kind = 'char', rate = SAMPLE_RATE, random = seededNoise(2)) {
  const wide = kind === 'space' || kind === 'enter';
  return tap({
    rate,
    random,
    seconds: wide ? 0.07 : 0.05,
    bright: wide ? 2800 : 3600,
    dark: wide ? 500 : 700,
    tickDecay: wide ? 0.007 : 0.005,
    thumpHz: (wide ? 135 : 190) * (0.9 + random() * 0.2),
    thumpDecay: wide ? 0.018 : 0.012,
    thumpLevel: 0.85,
  });
}

/** How loud each effect is next to a voice at the target loudness (1 would be full scale). */
export const EFFECT_LEVEL = { click: 0.2, tap: 0.1, char: 0.085, space: 0.095, enter: 0.12, key: 0.12 };

// ---------------------------------------------------------------- loudness (ITU-R BS.1770)

// The "K-weighting" curve from the standard, as two filters, for 48 kHz audio: a shelf that
// lifts what the ear hears as loud, then a high-pass that ignores rumble.
const K_SHELF = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const K_HIGHPASS = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

function biquad(input, { b0, b1, b2, a1, a2 }) {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * Integrated loudness in LUFS, the way broadcast meters and ffmpeg's ebur128 measure it.
 * Quiet gaps between sentences are left out (gating), so a voice with pauses measures the
 * same as one without. Returns -Infinity for silence.
 * @param {Float32Array[]} channels  one array for mono, two for stereo, at 48 kHz
 */
export function loudness(channels, rate = SAMPLE_RATE) {
  if (rate !== SAMPLE_RATE) throw new Error('loudness() needs 48 kHz audio.');
  const length = channels[0]?.length ?? 0;
  if (!length) return -Infinity;
  const weighted = channels.map((channel) => biquad(biquad(channel, K_SHELF), K_HIGHPASS));
  const block = Math.round(0.4 * rate);
  const step = Math.round(0.1 * rate);
  const energies = [];
  if (length < block) {
    let sum = 0;
    for (const channel of weighted) for (let i = 0; i < length; i++) sum += channel[i] * channel[i];
    energies.push(sum / length);
  } else {
    // Squares are summed once, so each 400 ms block is a difference of two running totals.
    const total = new Float64Array(length + 1);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const channel of weighted) sum += channel[i] * channel[i];
      total[i + 1] = total[i] + sum;
    }
    for (let start = 0; start + block <= length; start += step) energies.push((total[start + block] - total[start]) / block);
  }
  const lufs = (energy) => -0.691 + 10 * Math.log10(energy);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const audible = energies.filter((energy) => energy > 0 && lufs(energy) > -70);
  if (!audible.length) return -Infinity;
  const gate = lufs(mean(audible)) - 10;
  const counted = audible.filter((energy) => lufs(energy) > gate);
  return counted.length ? lufs(mean(counted)) : -Infinity;
}

// ---------------------------------------------------------------- shaping

/** Remove rumble below `hz` (a second-order high-pass). */
export function highPass(samples, hz = 80, rate = SAMPLE_RATE) {
  const w = (TAU * hz) / rate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return biquad(samples, {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  });
}

/**
 * Where the speech starts and ends in a clip, in samples. Voice engines pad their output
 * with silence; leaving it in would make every line start late.
 */
export function speechBounds(samples, rate = SAMPLE_RATE) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const threshold = Math.max(0.003, peak * 0.02);
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first++;
  if (first === samples.length) return { start: 0, end: 0 };
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < threshold) last--;
  return {
    start: Math.max(0, first - Math.round(0.015 * rate)),
    end: Math.min(samples.length, last + 1 + Math.round(0.06 * rate)),
  };
}

/**
 * Keep every sample at or under `ceiling` without the crackle of clipping. The limiter looks
 * 5 ms ahead, so it has already turned down when a peak arrives, then lets go over 80 ms.
 * Left and right are turned down together so the sound does not shift sideways. In place.
 */
export function limit(channels, ceiling = CEILING, rate = SAMPLE_RATE) {
  const length = channels[0]?.length ?? 0;
  const ahead = Math.max(1, Math.round(0.005 * rate));
  const need = new Float32Array(length);
  let limited = false;
  for (let i = 0; i < length; i++) {
    let peak = 0;
    for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i]));
    need[i] = peak > ceiling ? ceiling / peak : 1;
    if (peak > ceiling) limited = true;
  }
  if (!limited) return channels;

  // The lowest gain needed anywhere in the next `ahead` samples (a sliding-window minimum).
  const lowest = new Float32Array(length);
  const queue = new Int32Array(length);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < length; i++) {
    const end = Math.min(length - 1, i + ahead);
    for (; next <= end; next++) {
      while (tail > head && need[queue[tail - 1]] >= need[next]) tail--;
      queue[tail++] = next;
    }
    while (queue[head] < i) head++;
    lowest[i] = need[queue[head]];
  }
  // Recover slowly after a peak, never rising above what the peaks ahead allow.
  const release = 1 - Math.exp(-1 / (0.08 * rate));
  let gain = 1;
  for (let i = 0; i < length; i++) {
    gain = Math.min(lowest[i], gain + (1 - gain) * release);
    lowest[i] = gain;
  }
  // Averaging over the look-ahead turns each step down into a ramp that ends before the peak.
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += lowest[i];
    if (i >= ahead) sum -= lowest[i - ahead];
    const smooth = sum / Math.min(i + 1, ahead);
    for (const channel of channels) channel[i] *= smooth;
  }
  return channels;
}

/**
 * A volume curve for the music: 1 normally, `depth` while someone speaks. It starts down
 * just before each line so the first word is clear, and comes back gently after the last.
 * @param {Array<[number, number]>} speaking  start and end of each spoken line, in seconds
 */
export function duckCurve(length, speaking, { depth = fromDb(-9), lead = 0.15, hold = 0.25, down = 0.05, up = 0.2, rate = SAMPLE_RATE } = {}) {
  const target = new Float32Array(length).fill(1);
  for (const [start, end] of speaking) {
    const from = clamp(Math.floor((start - lead) * rate), 0, length);
    const to = clamp(Math.ceil((end + hold) * rate), 0, length);
    target.fill(depth, from, to);
  }
  const fall = 1 - Math.exp(-1 / (down * rate));
  const rise = 1 - Math.exp(-1 / (up * rate));
  let gain = 1;
  for (let i = 0; i < length; i++) {
    gain += (target[i] - gain) * (target[i] < gain ? fall : rise);
    target[i] = gain;
  }
  return target;
}

/**
 * Make a music track exactly `length` samples long: cut it if it is longer, repeat it with
 * a short cross-fade if it is shorter, and fade it in at the start and out at the end.
 */
export function fitMusic(left, right, length, rate = SAMPLE_RATE) {
  const source = [left, right || left];
  const have = source[0].length;
  const out = [new Float32Array(length), new Float32Array(length)];
  if (!have || !length) return out;
  const cross = Math.min(Math.round(0.4 * rate), Math.floor(have / 4));
  const stride = Math.max(1, have - cross);
  for (let offset = 0; offset < length; offset += stride) {
    const count = Math.min(have, length - offset);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < count; i++) {
        // Each repeat fades in over the tail of the one before it, which fades out.
        const fadeIn = offset > 0 && i < cross ? i / cross : 1;
        const fadeOut = offset + have < length && i >= have - cross ? (have - i) / cross : 1;
        out[c][offset + i] += source[c][i] * fadeIn * fadeOut;
      }
    }
    if (have >= length) break;
  }
  const fadeIn = Math.min(Math.round(0.5 * rate), Math.floor(length / 4));
  const fadeOut = Math.min(Math.round(1.5 * rate), Math.floor(length / 3));
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < fadeIn; i++) out[c][i] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) out[c][length - 1 - i] *= i / fadeOut;
  }
  return out;
}

/** Turn a channel list into one mono array. */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i] += channel[i] / channels.length;
  return out;
}

// ---------------------------------------------------------------- the mix

/**
 * Mix the whole soundtrack.
 *
 * @param {object} options
 * @param {number} options.length   length of the video in samples
 * @param {Array<{at:number, samples:Float32Array}>} [options.voice]   spoken lines: start in seconds, mono samples
 * @param {Array<{at:number, kind:string, pan?:number}>} [options.effects]   clicks, taps and key presses
 * @param {number} [options.effectsVolume]   1 is the designed level
 * @param {{left:Float32Array, right?:Float32Array, volume?:number}|null} [options.music]
 * @param {number} [options.seed]
 * @returns {{left:Float32Array, right:Float32Array, info:object}}
 */
export function mixSoundtrack({ length, voice = [], effects = [], effectsVolume = 1, music = null, seed = 1, rate = SAMPLE_RATE }) {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const random = seededNoise(seed);
  const info = { voiceLines: 0, voiceSeconds: 0, effects: 0, music: false, lufs: -Infinity, peak: 0, gainDb: 0 };

  // ---- voice: every line is brought to the same loudness, then placed in the middle.
  const speaking = [];
  for (const line of voice) {
    if (!line.samples?.length) continue;
    const clip = highPass(line.samples, 80, rate);
    const measured = loudness([clip, clip], rate);
    const gain = Number.isFinite(measured) ? fromDb(clamp(TARGET_LUFS - measured, -30, 30)) : 1;
    const fade = Math.min(Math.round(0.004 * rate), Math.floor(clip.length / 2));
    const start = Math.round(line.at * rate);
    for (let i = 0; i < clip.length; i++) {
      const at = start + i;
      if (at < 0 || at >= length) continue;
      const edge = fade > 0 ? Math.min(1, i / fade, (clip.length - 1 - i) / fade) : 1;
      const value = clip[i] * gain * edge;
      left[at] += value;
      right[at] += value;
    }
    speaking.push([line.at, line.at + clip.length / rate]);
    info.voiceLines++;
    info.voiceSeconds += clip.length / rate;
  }

  // ---- music: under the voice when there is one, and lower still while it speaks.
  if (music?.left?.length && (music.volume ?? 1) > 0) {
    const bed = fitMusic(music.left, music.right, length, rate);
    const measured = loudness(bed, rate);
    if (Number.isFinite(measured)) {
      const level = fromDb(clamp(TARGET_LUFS - measured, -30, 30)) * (music.volume ?? 1) * (speaking.length ? fromDb(-10) : 1);
      const duck = speaking.length ? duckCurve(length, speaking, { rate }) : null;
      for (let i = 0; i < length; i++) {
        const gain = duck ? level * duck[i] : level;
        left[i] += bed[0][i] * gain;
        right[i] += bed[1][i] * gain;
      }
      info.music = true;
    }
  }

  // ---- loudness: voice and music are brought to the target together, before the effects,
  // so a click sounds the same whether the video has one spoken line or twenty.
  if (info.voiceLines || info.music) {
    const measured = loudness([left, right], rate);
    if (Number.isFinite(measured)) {
      const gain = fromDb(clamp(TARGET_LUFS - measured, -12, 12));
      info.gainDb = Math.round(toDb(gain) * 10) / 10;
      for (let i = 0; i < length; i++) {
        left[i] *= gain;
        right[i] *= gain;
      }
    }
  }

  // ---- effects
  if (effectsVolume > 0) {
    for (const effect of effects) {
      const level = EFFECT_LEVEL[effect.kind];
      if (!level) continue;
      // A tap on a touch screen has no button to click: it gets the soft sound of a key.
      const sound = effect.kind === 'click' ? clickSound(rate, random) : keySound(effect.kind === 'tap' ? 'char' : effect.kind, rate, random);
      // No two presses are equally hard.
      const gain = level * effectsVolume * (0.8 + random() * 0.4);
      const pan = clamp(effect.pan ?? 0, -1, 1);
      const toLeft = Math.cos(((pan + 1) / 4) * Math.PI) * Math.SQRT2;
      const toRight = Math.sin(((pan + 1) / 4) * Math.PI) * Math.SQRT2;
      const start = Math.round(effect.at * rate);
      for (let i = 0; i < sound.length; i++) {
        const at = start + i;
        if (at < 0 || at >= length) continue;
        left[at] += sound[i] * gain * toLeft;
        right[at] += sound[i] * gain * toRight;
      }
      info.effects++;
    }
  }

  limit([left, right], CEILING, rate);
  for (let i = 0; i < length; i++) info.peak = Math.max(info.peak, Math.abs(left[i]), Math.abs(right[i]));
  info.lufs = loudness([left, right], rate);
  info.voiceSeconds = Math.round(info.voiceSeconds * 10) / 10;
  return { left, right, info };
}

// ---------------------------------------------------------------- WAV

/** Write samples as a 16-bit WAV file. @param {Float32Array[]} channels */
export function encodeWav(channels, rate = SAMPLE_RATE) {
  const count = channels.length;
  const length = channels[0].length;
  const bytes = new Uint8Array(44 + length * count * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset, value) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, length * count * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < count; c++) {
      view.setInt16(offset, Math.round(clamp(channels[c][i], -1, 1) * 32767), true);
      offset += 2;
    }
  }
  return bytes;
}

/** Read a 16-bit PCM WAV file. Returns the channels as floats and the sample rate. */
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let format = null;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (tag(offset) === 'fmt ') {
      format = { kind: view.getUint16(body, true), channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (tag(offset) === 'data') {
      if (!format || format.kind !== 1 || format.bits !== 16) throw new Error('Only 16-bit PCM WAV files can be read here.');
      const frames = Math.floor(Math.min(size, bytes.length - body) / (format.channels * 2));
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < format.channels; c++) channels[c][i] = view.getInt16(body + (i * format.channels + c) * 2, true) / 32768;
      }
      return { channels, rate: format.rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('The WAV file has no sound data.');
}
