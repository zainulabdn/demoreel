import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CEILING, EFFECT_LEVEL, SAMPLE_RATE, TARGET_LUFS,
  clickSound, decodeWav, duckCurve, encodeWav, fitMusic, highPass, keySound, limit, loudness, mixSoundtrack, seededNoise, speechBounds,
} from '../skills/demoreel/assets/audio.js';

const RATE = SAMPLE_RATE;
const TAU = Math.PI * 2;

const sine = (hz, seconds, level = 1) => {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = level * Math.sin((TAU * hz * i) / RATE);
  return out;
};
const peakOf = (samples, from = 0, to = samples.length) => {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
};
const rms = (samples, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
};
/** Something shaped like speech: bursts of a buzzy tone with short gaps between words. */
const speechLike = (seconds, level = 0.3, seed = 7) => {
  const random = seededNoise(seed);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const word = Math.sin(TAU * 3 * t) > -0.3 ? 1 : 0;
    out[i] = level * word * (0.6 * Math.sin(TAU * 180 * t) + 0.3 * Math.sin(TAU * 720 * t) + 0.1 * (random() * 2 - 1));
  }
  return out;
};

// ---------------------------------------------------------------- loudness

test('loudness: a full-scale 997 Hz tone in one channel measures -3.01 LUFS, as the standard says', () => {
  const tone = sine(997, 3, 1);
  assert.ok(Math.abs(loudness([tone, new Float32Array(tone.length)]) - -3.01) < 0.05);
});

test('loudness: the same tone in both channels is 3 dB louder, and half the level is 6 dB quieter', () => {
  const tone = sine(997, 3, 1);
  const half = sine(997, 3, 0.5);
  assert.ok(Math.abs(loudness([tone, tone]) - 0) < 0.05);
  assert.ok(Math.abs(loudness([half, half]) - -6.02) < 0.05);
});

test('loudness: pauses between sentences do not make a voice measure quieter', () => {
  const tone = sine(997, 2, 0.25);
  const withPause = new Float32Array(tone.length * 3);
  withPause.set(tone, 0);
  withPause.set(tone, tone.length * 2);
  // Without gating the two-second pause would cost 1.8 dB.
  assert.ok(Math.abs(loudness([tone]) - loudness([withPause])) < 0.6);
});

test('loudness: silence, an empty clip and a very short clip are handled', () => {
  assert.equal(loudness([new Float32Array(RATE)]), -Infinity);
  assert.equal(loudness([new Float32Array(0)]), -Infinity);
  assert.ok(Number.isFinite(loudness([sine(997, 0.1, 0.5)])));
  assert.throws(() => loudness([sine(997, 1)], 44100), /48 kHz/);
});

test('loudness: low rumble counts for far less than the same level in the voice range', () => {
  assert.ok(loudness([sine(20, 3, 0.5)]) < loudness([sine(1000, 3, 0.5)]) - 10);
});

// ---------------------------------------------------------------- shaping

test('highPass removes rumble and leaves the voice range alone', () => {
  const low = highPass(sine(25, 1, 0.5));
  const mid = highPass(sine(400, 1, 0.5));
  assert.ok(rms(low, RATE / 2) < 0.06, `25 Hz left at ${rms(low, RATE / 2)}`);
  assert.ok(Math.abs(rms(mid, RATE / 2) - 0.5 / Math.SQRT2) < 0.01);
});

test('speechBounds finds the speech inside the silence a voice engine adds around it', () => {
  const clip = new Float32Array(RATE * 2);
  clip.set(sine(300, 0.5, 0.4), Math.round(0.4 * RATE));
  const bounds = speechBounds(clip);
  assert.ok(bounds.start > 0.37 * RATE && bounds.start <= 0.4 * RATE, `start ${bounds.start / RATE}`);
  assert.ok(bounds.end >= 0.9 * RATE && bounds.end < 1.0 * RATE, `end ${bounds.end / RATE}`);
  assert.deepEqual(speechBounds(new Float32Array(1000)), { start: 0, end: 0 });
});

test('limit keeps every sample under the ceiling and leaves quiet sound untouched', () => {
  const loud = sine(220, 1, 0.5);
  for (let i = 20000; i < 20400; i++) loud[i] *= 4;
  const copy = Float32Array.from(loud);
  limit([loud]);
  assert.ok(peakOf(loud) <= CEILING + 1e-6, `peak ${peakOf(loud)}`);
  // Before the peak nothing changed, and well after it the level is back.
  for (const i of [100, 5000]) assert.equal(loud[i], copy[i]);
  assert.ok(Math.abs(loud[40000] - copy[40000]) < 0.005);

  const quiet = sine(220, 0.5, 0.3);
  const before = Float32Array.from(quiet);
  limit([quiet]);
  assert.deepEqual(quiet, before);
});

test('limit turns left and right down together', () => {
  const left = sine(220, 0.5, 1.5);
  const right = sine(220, 0.5, 0.3);
  limit([left, right]);
  assert.ok(peakOf(left) <= CEILING + 1e-6);
  assert.ok(Math.abs(peakOf(right) / peakOf(left) - 0.2) < 0.02, 'the balance between the channels is kept');
});

test('duckCurve is down before a line starts and back up after it ends', () => {
  const curve = duckCurve(RATE * 6, [[2, 3]], { depth: 0.3 });
  assert.equal(curve[RATE], 1);
  assert.ok(curve[Math.round(2 * RATE)] < 0.36, `at the first word: ${curve[Math.round(2 * RATE)]}`);
  assert.ok(Math.abs(curve[Math.round(2.5 * RATE)] - 0.3) < 0.01);
  assert.ok(curve[Math.round(3.1 * RATE)] < 0.35, 'stays down for a moment after the last word');
  assert.ok(curve[Math.round(4.5 * RATE)] > 0.98);
});

test('fitMusic cuts a long track, repeats a short one, and fades both ends', () => {
  const long = fitMusic(sine(440, 10, 0.5), null, RATE * 4);
  assert.equal(long[0].length, RATE * 4);
  assert.equal(long[0][0], 0);
  assert.ok(peakOf(long[0], RATE, RATE * 2) > 0.49);
  assert.ok(peakOf(long[0], RATE * 4 - 200) < 0.01, 'fades out at the end');

  const short = fitMusic(sine(440, 1.5, 0.5), sine(440, 1.5, 0.25), RATE * 6);
  // No silent hole and no doubled level where one repeat hands over to the next.
  for (let second = 1; second < 4; second += 0.25) {
    const level = rms(short[0], Math.round(second * RATE), Math.round((second + 0.25) * RATE));
    assert.ok(level > 0.2 && level < 0.5, `level ${level} at ${second}s`);
  }
  assert.ok(Math.abs(rms(short[1], RATE * 2, RATE * 3) / rms(short[0], RATE * 2, RATE * 3) - 0.5) < 0.05, 'right channel is kept');
  assert.deepEqual([...fitMusic(new Float32Array(0), null, 10)[0]], new Array(10).fill(0));
});

// ---------------------------------------------------------------- effects

test('click and key sounds are short, start and end quietly, and peak at exactly 1', () => {
  for (const sound of [clickSound(), keySound('char'), keySound('space'), keySound('enter'), keySound('key')]) {
    assert.ok(sound.length <= 0.08 * RATE);
    assert.ok(Math.abs(peakOf(sound) - 1) < 1e-6);
    assert.equal(Math.abs(sound[0]), 0);
    assert.ok(Math.abs(sound.at(-1)) < 0.02, `ends at ${sound.at(-1)}`);
    assert.ok(sound.every((value) => Number.isFinite(value)));
  }
});

test('the same seed gives the same sound, and each key is a little different', () => {
  assert.deepEqual(keySound('char', RATE, seededNoise(5)), keySound('char', RATE, seededNoise(5)));
  assert.notDeepEqual(keySound('char', RATE, seededNoise(5)), keySound('char', RATE, seededNoise(6)));
});

// ---------------------------------------------------------------- the mix

test('mix: a voice comes out at the target loudness, in the middle, where it was placed', () => {
  const length = RATE * 8;
  const { left, right, info } = mixSoundtrack({ length, voice: [{ at: 2, samples: speechLike(3, 0.05) }] });
  assert.ok(Math.abs(info.lufs - TARGET_LUFS) < 0.6, `loudness ${info.lufs}`);
  assert.ok(info.peak <= CEILING + 1e-6);
  assert.deepEqual(left, right);
  assert.equal(peakOf(left, 0, Math.round(1.99 * RATE)), 0);
  assert.equal(peakOf(left, Math.round(5.01 * RATE)), 0);
  assert.equal(info.voiceLines, 1);
  assert.equal(info.voiceSeconds, 3);
});

test('mix: quiet and loud lines end up equally loud', () => {
  const length = RATE * 9;
  const { left } = mixSoundtrack({
    length,
    voice: [{ at: 0.5, samples: speechLike(3, 0.02, 1) }, { at: 5, samples: speechLike(3, 0.6, 2) }],
  });
  const first = loudness([left.subarray(Math.round(0.5 * RATE), Math.round(3.5 * RATE))]);
  const second = loudness([left.subarray(5 * RATE, 8 * RATE)]);
  assert.ok(Math.abs(first - second) < 1, `${first} against ${second}`);
});

test('mix: music steps back while the voice speaks and returns after', () => {
  const length = RATE * 12;
  const music = sine(330, 12, 0.3);
  const quietVoice = new Float32Array(RATE * 3); // a line that makes no sound still marks when someone speaks
  quietVoice[100] = 1e-9;
  const { left } = mixSoundtrack({ length, voice: [{ at: 4, samples: quietVoice }], music: { left: music, right: music } });
  const before = rms(left, 2 * RATE, 3 * RATE);
  const during = rms(left, 5 * RATE, 6 * RATE);
  const after = rms(left, 9 * RATE, 10 * RATE);
  assert.ok(during < before * 0.45, `during ${during}, before ${before}`);
  assert.ok(Math.abs(after - before) / before < 0.1);
});

test('mix: music alone fills the soundtrack at the target loudness; volume 0 turns it off', () => {
  const length = RATE * 6;
  const music = sine(330, 6, 0.05);
  const alone = mixSoundtrack({ length, music: { left: music, right: music } });
  assert.ok(Math.abs(alone.info.lufs - TARGET_LUFS) < 1, `loudness ${alone.info.lufs}`);
  assert.equal(alone.info.music, true);
  const off = mixSoundtrack({ length, music: { left: music, right: music, volume: 0 } });
  assert.equal(off.info.music, false);
  assert.equal(peakOf(off.left), 0);
});

test('mix: effects land on time, at their designed level, and follow the cursor left and right', () => {
  const length = RATE * 4;
  const { left, right, info } = mixSoundtrack({
    length,
    effects: [{ at: 1, kind: 'click', pan: -0.5 }, { at: 2, kind: 'char' }, { at: 3, kind: 'click', pan: 0.5 }, { at: 3.5, kind: 'nonsense' }],
  });
  assert.equal(info.effects, 3);
  assert.equal(peakOf(left, 0, RATE - 1), 0);
  const click = peakOf(left, RATE, RATE + 2400);
  assert.ok(click > EFFECT_LEVEL.click * 0.7 && click < EFFECT_LEVEL.click * 1.9, `click peak ${click}`);
  assert.ok(peakOf(left, RATE, RATE + 2400) > peakOf(right, RATE, RATE + 2400), 'a click on the left is louder on the left');
  assert.ok(peakOf(right, 3 * RATE, 3 * RATE + 2400) > peakOf(left, 3 * RATE, 3 * RATE + 2400));
  assert.ok(Math.abs(peakOf(left, 2 * RATE, 2 * RATE + 2400) - peakOf(right, 2 * RATE, 2 * RATE + 2400)) < 1e-6, 'a key is in the middle');
  assert.ok(peakOf(left, 2 * RATE, 2 * RATE + 2400) < click, 'keys are quieter than clicks');

  const silent = mixSoundtrack({ length, effects: [{ at: 1, kind: 'click' }], effectsVolume: 0 });
  assert.equal(peakOf(silent.left), 0);
});

test('mix: a click sounds the same with or without a voice elsewhere in the video', () => {
  const length = RATE * 8;
  const effects = [{ at: 1, kind: 'click' }];
  const withVoice = mixSoundtrack({ length, effects, voice: [{ at: 3, samples: speechLike(3, 0.01) }] });
  const without = mixSoundtrack({ length, effects });
  assert.ok(Math.abs(peakOf(withVoice.left, RATE, RATE + 2400) - peakOf(without.left, RATE, RATE + 2400)) < 1e-6);
});

test('mix: the same input gives the same soundtrack, and nothing is written past the end', () => {
  const options = { length: RATE * 3, effects: [{ at: 0.5, kind: 'char' }, { at: 2.99, kind: 'click' }, { at: -0.01, kind: 'key' }], voice: [{ at: 2.5, samples: speechLike(2) }] };
  const a = mixSoundtrack(options);
  const b = mixSoundtrack(options);
  assert.deepEqual(a.left, b.left);
  assert.equal(a.left.length, RATE * 3);
  assert.ok(a.left.every((value) => Number.isFinite(value)));
});

// ---------------------------------------------------------------- WAV

test('WAV: what is written can be read back', () => {
  const left = sine(440, 0.1, 0.5);
  const right = sine(880, 0.1, 0.25);
  const file = encodeWav([left, right]);
  assert.equal(file.length, 44 + left.length * 4);
  const read = decodeWav(file);
  assert.equal(read.rate, RATE);
  assert.equal(read.channels.length, 2);
  for (const i of [0, 100, 2000, left.length - 1]) {
    assert.ok(Math.abs(read.channels[0][i] - left[i]) < 1 / 16000);
    assert.ok(Math.abs(read.channels[1][i] - right[i]) < 1 / 16000);
  }
});

test('WAV: samples beyond full scale are clipped, not wrapped around', () => {
  const read = decodeWav(encodeWav([Float32Array.from([2, -2, 0])], 24000));
  assert.equal(read.rate, 24000);
  assert.ok(read.channels[0][0] > 0.99 && read.channels[0][1] < -0.99);
});

test('WAV: other files are refused with a clear message', () => {
  assert.throws(() => decodeWav(new Uint8Array(100)), /Not a WAV file/);
});
