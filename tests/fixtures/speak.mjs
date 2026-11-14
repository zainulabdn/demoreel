// A stand-in for a text-to-speech program, used by the tests so they need no real voice.
//
//   node speak.mjs <out.wav>      the words arrive on standard input
//
// It "speaks" a tone that lasts longer for longer text, with silence before and after it,
// the way real voice engines pad their output.

import { writeFileSync } from 'node:fs';
import { encodeWav } from '../../skills/demoreel/assets/audio.js';

let text = '';
for await (const chunk of process.stdin) text += chunk;

const rate = 24000;
const speech = Math.round(rate * (0.3 + text.trim().length * 0.04));
const quiet = Math.round(rate * 0.2);
const samples = new Float32Array(speech + quiet * 2);
for (let i = 0; i < speech; i++) {
  const edge = Math.min(1, i / 240, (speech - 1 - i) / 240);
  samples[quiet + i] = 0.3 * edge * Math.sin((Math.PI * 2 * 220 * i) / rate);
}
writeFileSync(process.argv[2], encodeWav([samples], rate));
