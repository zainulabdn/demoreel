import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameThinner } from '../skills/demoreel/scripts/lib/record.mjs';

/** A thinner whose hold timer is fired by hand. */
function thinner(minGap = 25) {
  const kept = [];
  let timer = null;
  const frames = frameThinner(minGap, (frame) => kept.push(frame.epochMs), {
    setTimer: (run) => (timer = run),
    clearTimer: () => (timer = null),
  });
  return { kept, push: (t) => frames.push({ epochMs: t }), flush: frames.flush, waiting: () => timer !== null, fire: () => timer?.() };
}

test('frames at 60 a second are thinned to 30 a second', () => {
  const frames = thinner();
  for (let i = 0; i < 9; i++) frames.push(Math.round(i * 16.7));
  assert.deepEqual(frames.kept, [0, 33, 67, 100, 134]);
});

test('a frame on its own is always kept at once', () => {
  const frames = thinner();
  for (const t of [0, 400, 2000, 2300]) frames.push(t);
  assert.deepEqual(frames.kept, [0, 400, 2000, 2300]);
  assert.equal(frames.waiting(), false);
});

test('the last frame of a burst is kept even when it comes too soon', () => {
  const frames = thinner();
  frames.push(0);
  frames.push(17);
  assert.deepEqual(frames.kept, [0], 'held back for now');
  assert.equal(frames.waiting(), true);
  frames.fire();
  assert.deepEqual(frames.kept, [0, 17], 'kept once nothing newer followed');
});

test('a held frame is replaced by a newer one, never kept out of order', () => {
  const frames = thinner();
  for (const t of [0, 10, 20, 30]) frames.push(t);
  assert.deepEqual(frames.kept, [0, 30], 'the frames at 10 and 20 gave way to the one at 30');
  assert.equal(frames.waiting(), false);
  frames.push(47);
  frames.fire();
  frames.push(60);
  assert.deepEqual(frames.kept, [0, 30, 47], 'the gap is counted from the frame kept last');
});

test('flush keeps the frame being held, and does nothing when there is none', () => {
  const frames = thinner();
  frames.flush();
  assert.deepEqual(frames.kept, []);
  frames.push(0);
  frames.push(12);
  frames.flush();
  assert.deepEqual(frames.kept, [0, 12]);
  assert.equal(frames.waiting(), false);
  frames.flush();
  assert.deepEqual(frames.kept, [0, 12]);
});
