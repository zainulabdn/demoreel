// How the cursor travels between two points: a gentle arc with a soft start and stop,
// the way a hand moves a mouse. Pure functions, so the motion is testable and repeatable.

import { clamp, easeMinJerk } from './util.mjs';

/**
 * Plan one cursor move.
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @param {() => number} random  a seeded generator returning 0..1
 * @returns {{duration:number, at:(progress:number)=>{x:number,y:number}}}
 */
export function planMove(from, to, random = Math.random) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.5) return { duration: 0, at: () => ({ x: to.x, y: to.y }) };

  const duration = clamp(280 + distance * 0.75, 320, 1000);
  // Bend the path sideways a little. Longer moves bend more, up to a limit.
  const bend = (random() - 0.5) * 2 * Math.min(distance * 0.12, 60);
  const control = {
    x: (from.x + to.x) / 2 + (-dy / distance) * bend,
    y: (from.y + to.y) / 2 + (dx / distance) * bend,
  };

  return {
    duration,
    at(progress) {
      const t = easeMinJerk(progress);
      const inverse = 1 - t;
      return {
        x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
        y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
      };
    },
  };
}

/**
 * Cursor position at a moment in time, from recorded samples `[t, x, y]` sorted by time.
 * @param {Array<[number, number, number]>} samples
 * @param {number} time
 * @param {number} [hint] index to start searching from (speeds up sequential lookups)
 * @returns {{x:number, y:number, index:number}}
 */
export function cursorAt(samples, time, hint = 0) {
  if (!samples.length) return { x: 0, y: 0, index: 0 };
  let index = clamp(hint, 0, samples.length - 1);
  if (samples[index][0] > time) index = 0;
  while (index + 1 < samples.length && samples[index + 1][0] <= time) index++;
  const current = samples[index];
  const next = samples[index + 1];
  if (!next || time <= current[0]) return { x: current[1], y: current[2], index };
  const span = next[0] - current[0];
  const t = span > 0 ? (time - current[0]) / span : 1;
  return { x: current[1] + (next[1] - current[1]) * t, y: current[2] + (next[2] - current[2]) * t, index };
}
