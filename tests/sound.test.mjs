// The sound settings in a storyboard, the plan for the soundtrack, subtitles, and choosing a voice.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../skills/demoreel/assets/audio.js';
import { bitrateFor, buildPlan } from '../skills/demoreel/scripts/lib/plan.mjs';
import { AUDIO_BITRATE, buildAudioPlan, subtitleCues, toSrt } from '../skills/demoreel/scripts/lib/sound.mjs';
import { normalizeStoryboard } from '../skills/demoreel/scripts/lib/storyboard.mjs';
import { DemoreelError } from '../skills/demoreel/scripts/lib/util.mjs';
import { NATURAL_VOICE, applyPronunciation, naturalVoice, prepareVoice, resolveVoice, splitCommand, voiceHome } from '../skills/demoreel/scripts/lib/voice.mjs';

const dir = mkdtempSync(join(tmpdir(), 'demoreel-sound-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'demo.reel.json');
for (const name of ['music.mp3', 'intro.m4a']) writeFileSync(join(dir, name), 'not really sound');

const story = (extra = {}) => normalizeStoryboard({ url: 'http://localhost:3000', steps: [{ say: 'Start a project' }, { click: 'Go' }], ...extra }, file);
const failsWith = (extra, pattern, hint) => {
  assert.throws(
    () => story(extra),
    (error) => {
      assert.ok(error instanceof DemoreelError, `expected a DemoreelError, got ${error}`);
      assert.match(error.message, pattern);
      if (hint) assert.match(error.hint, hint);
      return true;
    },
  );
};

// ---------------------------------------------------------------- storyboard

test('a storyboard is silent unless it asks for sound', () => {
  assert.equal(story().sound, null);
  assert.equal(story({ sound: false }).sound, null);
  assert.equal(story().steps[0].spoken, undefined);
});

test('"sound": true gives a voice and click sounds', () => {
  const { sound, steps } = story({ sound: true });
  assert.deepEqual(sound, { voice: { engine: 'auto', name: null, speed: 1, command: null }, effects: 1, music: null, pronounce: {} });
  assert.equal(steps[0].spoken, 'Start a project', 'the caption is what is spoken');
});

test('each part of the sound can be chosen on its own', () => {
  assert.equal(story({ sound: {} }).sound.voice, null, 'no voice unless asked');
  assert.equal(story({ sound: {} }).sound.effects, 1, 'click sounds are on by default');
  assert.equal(story({ sound: { voice: true, effects: false } }).sound.effects, 0);
  assert.equal(story({ sound: { effects: 0.5 } }).sound.effects, 0.5);
  assert.equal(story({ sound: { effects: { volume: 2 } } }).sound.effects, 2);
  assert.equal(story({ sound: { effects: false } }).sound, null, 'nothing left to hear');

  assert.deepEqual(story({ sound: { music: './music.mp3' } }).sound.music, { file: resolve(dir, 'music.mp3'), volume: 1 });
  assert.deepEqual(story({ sound: { music: { file: 'music.mp3', volume: 0.5 } } }).sound.music, { file: resolve(dir, 'music.mp3'), volume: 0.5 });
  assert.equal(story({ sound: { music: { file: 'music.mp3', volume: 0 } } }).sound.music, null);
});

test('the voice can be named, slowed down, or replaced by a command', () => {
  assert.equal(story({ sound: { voice: 'system' } }).sound.voice.engine, 'system');
  assert.equal(story({ sound: { voice: 'kokoro' } }).sound.voice.engine, 'natural', 'the model\'s own name is understood');
  assert.deepEqual(story({ sound: { voice: { engine: 'natural', name: 'bm_george', speed: 0.9 } } }).sound.voice, { engine: 'natural', name: 'bm_george', speed: 0.9, command: null });
  const custom = story({ sound: { voice: { command: 'piper --output_file {out}' } } }).sound.voice;
  assert.equal(custom.engine, 'command');
  assert.equal(custom.command, 'piper --output_file {out}');
});

test('a caption can say more than it shows, stay silent, or play a recorded clip', () => {
  const { steps } = story({
    sound: { voice: true },
    steps: [
      { say: 'Fast', speak: 'It is fast. Really fast.' },
      { say: 'Quiet', speak: false },
      { say: 'Mine', audio: './intro.m4a' },
      { say: '' },
      { say: 'Plain' },
    ],
  });
  assert.deepEqual(steps.map((step) => step.spoken), ['It is fast. Really fast.', undefined, 'Mine', undefined, 'Plain']);
  assert.equal(steps[2].audio, resolve(dir, 'intro.m4a'));
  assert.equal(steps[0].label, 'say "Fast"', 'the step is still described by its caption');
});

test('a recorded clip turns sound on by itself, and is played even without a voice', () => {
  const clipOnly = story({ steps: [{ say: 'Mine', audio: 'intro.m4a' }, { say: 'Caption only' }] });
  assert.equal(clipOnly.sound.voice, null);
  assert.deepEqual(clipOnly.steps.map((step) => step.spoken), ['Mine', undefined]);
});

test('sound mistakes are explained', () => {
  failsWith({ sound: 'loud' }, /"sound" must be true or an object/);
  failsWith({ sound: { volume: 2 } }, /"sound\.volume" is not a sound option/, /voice, effects, music, pronounce/);
  failsWith({ sound: { voice: 'robot' } }, /Unknown voice "robot"/, /auto, natural, system/);
  failsWith({ sound: { voice: { pitch: 2 } } }, /"sound\.voice\.pitch" is not a voice option/);
  failsWith({ sound: { voice: { speed: 5 } } }, /sound\.voice\.speed must be between 0\.5 and 2/);
  failsWith({ sound: { voice: { command: 'piper' } } }, /writes a sound file to \{out\}/);
  failsWith({ sound: { voice: { command: 'x {out}', engine: 'system' } } }, /both "command" and "engine"/);
  failsWith({ sound: { music: './missing.mp3' } }, /"sound\.music" points to \.\/missing\.mp3, which does not exist/, /relative to the storyboard/);
  failsWith({ sound: { music: 7 } }, /"sound\.music" must be the path/);
  failsWith({ sound: { effects: 9 } }, /sound\.effects must be between 0 and 3/);
  failsWith({ sound: { pronounce: { Demoreel: 5 } } }, /"sound\.pronounce" must map words/);
  failsWith({ steps: [{ say: 'Hi', speak: 'Hello' }] }, /Step 1 has "speak", but the storyboard has no voice/, /"sound": \{ "voice": true \}/);
  failsWith({ sound: { effects: true }, steps: [{ say: 'Hi', speak: 'Hello' }] }, /has "speak", but the storyboard has no voice/);
  failsWith({ sound: false, steps: [{ say: 'Hi', audio: 'intro.m4a' }] }, /Step 1 has "audio", but the storyboard has no voice/);
  failsWith({ sound: true, steps: [{ say: 'Hi', speak: '' }] }, /"speak" needs the words/);
  failsWith({ sound: true, steps: [{ say: 'Hi', audio: 'nope.wav' }] }, /Step 1: "audio" points to nope\.wav, which does not exist/);
  failsWith({ sound: true, steps: [{ say: 'Hi', audio: 'intro.m4a', speak: false }] }, /both "audio" and "speak": false/);
  failsWith({ sound: true, steps: [{ click: 'Go', speak: 'Hello' }] }, /does not understand: "speak"/);
});

test('"srt" is an output format', () => {
  assert.deepEqual(story({ output: { formats: ['mp4', 'srt'] } }).output.formats, ['mp4', 'srt']);
  failsWith({ output: { formats: ['mp3'] } }, /mp4, gif, srt/);
});

// ---------------------------------------------------------------- the plan for the soundtrack

const timeline = () => ({
  version: 1,
  viewport: { width: 1000, height: 600, scale: 2 },
  duration: 10000,
  frames: [0, 5000, 9900].map((t, i) => ({ t, file: `${String(i).padStart(6, '0')}.jpg` })),
  cursor: [[0, 500, 300], [10000, 500, 300]],
  cursorKinds: [{ t: 0, kind: 'default' }],
  clicks: [{ t: 3000, x: 100, y: 50 }, { t: 6000, x: 900, y: 50 }],
  keys: [{ t: 4000, kind: 'char' }, { t: 4100, kind: 'space' }, { t: 2000, kind: 'enter' }],
  voice: [
    { t: 800, step: 0, file: 'audio/voice-01.wav', skip: 30, duration: 2000, text: 'Start a project' },
    { t: 5000, step: 3, file: 'audio/voice-04.m4a', skip: 0, duration: 1500, text: 'Add tasks' },
  ],
  focus: [],
  wide: [],
  captions: [{ t0: 700, t1: 4900, text: 'Start' }, { t0: 4900, t1: 10000, text: 'Add' }],
  urls: [{ t: 0, url: 'http://127.0.0.1:4000/' }],
  steps: [{ index: 0, label: 'say "Start"', t0: 700, t1: 1100 }],
});

test('the soundtrack plan lists every spoken line, click and key press in order', () => {
  const plan = buildAudioPlan(timeline(), story({ sound: { voice: true, music: 'music.mp3' } }), 10000);
  assert.equal(plan.sampleRate, 48000);
  assert.equal(plan.durationMs, 10000);
  assert.deepEqual(plan.voice, [
    { t: 800, url: 'audio/voice-01.wav', skip: 30, duration: 2000 },
    { t: 5000, url: 'audio/voice-04.m4a', skip: 0, duration: 1500 },
  ]);
  assert.deepEqual(plan.effects.map((effect) => [effect.at, effect.kind]), [[2, 'enter'], [3, 'click'], [4, 'char'], [4.1, 'space'], [6, 'click']]);
  assert.deepEqual(plan.music, { url: 'music', volume: 1 });
  assert.equal(plan.effectsVolume, 1);
});

test('a click is heard on the side of the page it happened on, gently', () => {
  const plan = buildAudioPlan(timeline(), story({ sound: {} }), 10000);
  const [left, right] = plan.effects.filter((effect) => effect.kind === 'click');
  assert.ok(left.pan < 0 && left.pan >= -0.35, `left click pan ${left.pan}`);
  assert.ok(right.pan > 0 && right.pan <= 0.35);
});

test('on a phone, taps get a softer sound than a mouse click', () => {
  const phone = { ...timeline(), viewport: { width: 390, height: 844, scale: 3, mobile: true } };
  const plan = buildAudioPlan(phone, story({ sound: {} }), 10000);
  assert.ok(plan.effects.some((effect) => effect.kind === 'tap'));
  assert.ok(!plan.effects.some((effect) => effect.kind === 'click'));
});

test('there is no soundtrack for a silent storyboard, a GIF, or when nothing would be heard', () => {
  assert.equal(buildAudioPlan(timeline(), story(), 10000), null);
  assert.equal(buildAudioPlan(timeline(), story({ sound: true, output: { formats: ['gif'] } }), 10000), null);
  const quiet = { ...timeline(), clicks: [], keys: [], voice: [] };
  assert.equal(buildAudioPlan(quiet, story({ sound: true }), 10000), null);
  // A recording made before sound existed has no key presses or voice on its timeline.
  const old = timeline();
  delete old.keys;
  delete old.voice;
  assert.deepEqual(buildAudioPlan(old, story({ sound: true }), 10000).effects.map((effect) => effect.kind), ['click', 'click']);
});

test('with click sounds turned off, only the voice is left', () => {
  const plan = buildAudioPlan(timeline(), story({ sound: { voice: true, effects: false } }), 10000);
  assert.deepEqual(plan.effects, []);
  assert.equal(plan.voice.length, 2);
});

test('the render plan carries the soundtrack, and the picture gives up bitrate for it', () => {
  const silent = buildPlan(timeline(), story());
  assert.equal(silent.audio, null);
  const loud = buildPlan(timeline(), story({ sound: true }));
  assert.equal(loud.audio.voice.length, 2);
  assert.equal(loud.audio.durationMs, loud.durationMs);

  const output = story().output;
  const without = bitrateFor(output, 60_000);
  const withSound = bitrateFor(output, 60_000, AUDIO_BITRATE);
  assert.equal(without.bitrate - withSound.bitrate, AUDIO_BITRATE);
  assert.ok(((withSound.bitrate + AUDIO_BITRATE) * 60) / 8 / 1_000_000 <= 9.5, 'picture and sound together fit the size limit');
});

// ---------------------------------------------------------------- subtitles

test('subtitles are the spoken lines when there is a voice', () => {
  const cues = subtitleCues(timeline());
  assert.deepEqual(cues, [
    { start: 800, end: 3100, text: 'Start a project' },
    { start: 5000, end: 6800, text: 'Add tasks' },
  ]);
});

test('subtitles are the captions when nothing is spoken, and never overlap', () => {
  const silent = { ...timeline(), voice: [] };
  assert.deepEqual(subtitleCues(silent), [
    { start: 700, end: 4860, text: 'Start' },
    { start: 4900, end: 10000, text: 'Add' },
  ]);
  const crowded = { duration: 3000, voice: [{ t: 0, duration: 2000, text: 'One' }, { t: 1500, duration: 4000, text: 'Two' }] };
  assert.deepEqual(subtitleCues(crowded), [{ start: 0, end: 1460, text: 'One' }, { start: 1500, end: 3000, text: 'Two' }]);
  assert.deepEqual(subtitleCues({ duration: 1000 }), []);
});

test('the .srt file is numbered and timed the way players expect', () => {
  const srt = toSrt([{ start: 800, end: 3100, text: 'Start a project' }, { start: 3_725_004, end: 3_726_000, text: 'Two\nlines' }]);
  assert.equal(srt, '1\n00:00:00,800 --> 00:00:03,100\nStart a project\n\n2\n01:02:05,004 --> 01:02:06,000\nTwo lines\n');
  assert.equal(toSrt([]), '');
});

// ---------------------------------------------------------------- choosing and using a voice

const NATURAL = { installed: true };
const NO_NATURAL = { installed: false };
const SYSTEM = { tool: 'say' };
const ask = (voice = {}) => ({ engine: 'auto', name: null, speed: 1, command: null, ...voice });

test('the natural voice is used when it is installed, the built-in one otherwise', () => {
  const natural = resolveVoice(ask(), { natural: NATURAL, system: SYSTEM });
  assert.equal(natural.engine, 'natural');
  assert.equal(natural.name, NATURAL_VOICE.defaultName);
  assert.equal(natural.note, undefined);

  const builtIn = resolveVoice(ask(), { natural: NO_NATURAL, system: SYSTEM });
  assert.equal(builtIn.engine, 'system');
  assert.match(builtIn.note, /demoreel voice install/, 'says how to get a better voice');
});

test('a voice name picks the engine it belongs to', () => {
  assert.equal(resolveVoice(ask({ name: 'bm_george' }), { natural: NATURAL, system: SYSTEM }).engine, 'natural');
  assert.equal(resolveVoice(ask({ name: 'Samantha' }), { natural: NATURAL, system: SYSTEM }).engine, 'system');
  assert.equal(resolveVoice(ask({ name: 'Eddy (English (UK))' }), { natural: NATURAL, system: SYSTEM }).engine, 'system');
  assert.throws(() => resolveVoice(ask({ name: 'af_bella' }), { natural: NO_NATURAL, system: SYSTEM }), /"af_bella" is a natural voice/);
});

test('asking for a voice that is not there says how to get it', () => {
  const hint = (run) => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof DemoreelError);
      return `${error.message}\n${error.hint}`;
    }
    return assert.fail('should have thrown');
  };
  assert.match(hint(() => resolveVoice(ask({ engine: 'natural' }), { natural: NO_NATURAL, system: SYSTEM })), /not installed[\s\S]*demoreel voice install[\s\S]*"voice": "system"/);
  assert.match(hint(() => resolveVoice(ask({ engine: 'system' }), { natural: NATURAL, system: null })), /no built-in voice/);
  assert.match(hint(() => resolveVoice(ask(), { natural: NO_NATURAL, system: null })), /no voice on this computer[\s\S]*demoreel voice install/);
  assert.equal(resolveVoice(ask({ engine: 'command', command: 'x {out}' }), { natural: NO_NATURAL, system: null }).engine, 'command');
});

test('the natural voice is looked for in one folder, which can be moved', () => {
  assert.equal(voiceHome({ DEMOREEL_VOICE_DIR: '/somewhere/voice' }), '/somewhere/voice');
  assert.match(voiceHome({}), /\.demoreel[\\/]voice$/);
  assert.equal(naturalVoice({ DEMOREEL_VOICE_DIR: join(dir, 'no-voice-here') }).installed, false);
  for (const part of NATURAL_VOICE.files) {
    assert.match(part.url, /^https:\/\/github\.com\//);
    assert.match(part.sha256, /^[0-9a-f]{64}$/, 'every download is checked against a known checksum');
  }
});

test('a voice command is split like a shell would, without using one', () => {
  assert.deepEqual(splitCommand('piper --model en.onnx --output_file {out}'), ['piper', '--model', 'en.onnx', '--output_file', '{out}']);
  assert.deepEqual(splitCommand(`"/Program Files/tts.exe"  -o '{out}' --text "say \\"hi\\""`), ['/Program Files/tts.exe', '-o', '{out}', '--text', 'say "hi"']);
  assert.deepEqual(splitCommand(`'C:\\Program Files\\nodejs\\node.exe' speak.mjs ""`), ['C:\\Program Files\\nodejs\\node.exe', 'speak.mjs', '']);
  assert.deepEqual(splitCommand('   '), []);
  assert.throws(() => splitCommand('say "oops'), /never closed/);
});

test('pronunciations replace whole words only, whatever their case', () => {
  const pronounce = { Demoreel: 'Demo reel', 'C++': 'C plus plus' };
  assert.equal(applyPronunciation('Demoreel. Try demoreel, not Demoreels.', pronounce), 'Demo reel. Try Demo reel, not Demoreels.');
  assert.equal(applyPronunciation('Written in C++.', pronounce), 'Written in C plus plus.');
  assert.equal(applyPronunciation('Nothing to change', {}), 'Nothing to change');
});

test('spoken lines are made once per caption, with pronunciations applied, and reused next time', async () => {
  const speak = fileURLToPath(new URL('./fixtures/speak.mjs', import.meta.url));
  const heard = join(dir, 'heard.txt');
  // The stand-in voice writes a tone; wrapping it lets the test see which words it was given.
  const wrapper = join(dir, 'voice.mjs');
  writeFileSync(
    wrapper,
    `import { appendFileSync } from 'node:fs';
     import { spawnSync } from 'node:child_process';
     let text = '';
     for await (const chunk of process.stdin) text += chunk;
     appendFileSync(${JSON.stringify(heard)}, text + '\\n');
     spawnSync(process.execPath, [${JSON.stringify(speak)}, process.argv[2]], { input: text });`,
  );
  writeFileSync(heard, '');
  const narrated = story({
    sound: { voice: { command: `'${process.execPath}' '${wrapper}' {out}` }, pronounce: { Lumen: 'Loo men' } },
    steps: [{ say: 'Meet Lumen' }, { click: 'Go' }, { say: 'Quiet', speak: false }, { say: 'Fast', speak: 'It is fast.' }],
  });
  const work = join(dir, 'recording');
  const cacheDir = join(dir, 'cache');

  const first = await prepareVoice(narrated, work, { cacheDir });
  assert.deepEqual([first.spoken, first.reused, first.recorded], [2, 0, 0]);
  assert.deepEqual([...first.clips.keys()], [0, 3], 'by step number; the silent caption has no clip');
  assert.deepEqual(first.clips.get(0), { file: 'audio/voice-01.wav', text: 'Meet Lumen' });
  assert.equal(first.clips.get(3).text, 'It is fast.');
  assert.deepEqual(readFileSync(heard, 'utf8').trim().split('\n'), ['Meet Loo men', 'It is fast.'], 'the voice is given the pronunciation, the subtitle keeps the spelling');
  const wav = decodeWav(new Uint8Array(readFileSync(join(work, 'audio/voice-01.wav'))));
  assert.ok(wav.channels[0].length > 1000);

  const second = await prepareVoice(narrated, join(dir, 'recording-2'), { cacheDir });
  assert.deepEqual([second.spoken, second.reused], [2, 2]);
  assert.equal(readFileSync(heard, 'utf8').trim().split('\n').length, 2, 'nothing was spoken again');

  const silent = await prepareVoice(story(), join(dir, 'recording-3'), { cacheDir });
  assert.equal(silent.clips.size, 0);
});
