import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAMERA, buildShots, fitZoom, sampleCamera, shotContains } from '../skills/demoreel/scripts/lib/camera.mjs';

const viewport = { width: 1280, height: 720 };
const style = { zoom: 1.6 };
const timeline = (extra) => ({ viewport, duration: 20000, focus: [], wide: [], urls: [], ...extra });
const button = { x: 600, y: 300, w: 120, h: 40 };
const click = (t0, rect = button, extra = {}) => ({ kind: 'click', t0, t1: t0 + 150, approach: 500, rect, ...extra });

test('fitZoom zooms less for large targets and never below 1', () => {
  assert.equal(fitZoom(button, viewport, 1.6), 1.6);
  const wide = fitZoom({ x: 0, y: 0, w: 900, h: 100 }, viewport, 1.6);
  assert.ok(wide > 1 && wide < 1.6);
  assert.equal(fitZoom({ x: 0, y: 0, w: 1280, h: 720 }, viewport, 1.6), 1);
});

test('no shots at all when zoom is switched off', () => {
  assert.deepEqual(buildShots(timeline({ focus: [click(3000)] }), { zoom: 1 }), []);
});

test('a click gets a shot that starts as the cursor sets off and holds afterwards', () => {
  const [shot, ...rest] = buildShots(timeline({ focus: [click(3000)] }), style);
  assert.equal(rest.length, 0);
  assert.equal(shot.start, 3000 - 500 - CAMERA.lead);
  assert.equal(shot.end, 3150 + CAMERA.hold);
  assert.equal(shot.cx, 660);
  assert.equal(shot.cy, 320);
  assert.equal(shot.scale, 1.6);
});

test('two actions close together pan across without pulling back', () => {
  const far = { x: 100, y: 600, w: 100, h: 40 };
  const shots = buildShots(timeline({ focus: [click(3000), click(5000, far)] }), style);
  assert.equal(shots.length, 2);
  assert.equal(shots[0].end, shots[1].start, 'the second shot takes over exactly where the first ends');
});

test('two actions far apart are separate shots with the whole page in between', () => {
  const shots = buildShots(timeline({ focus: [click(3000), click(12000)] }), style);
  assert.equal(shots.length, 2);
  assert.ok(shots[1].start - shots[0].end > CAMERA.gap);
});

test('a key press keeps the running shot alive', () => {
  const shots = buildShots(timeline({ focus: [click(3000), { kind: 'key', t0: 4000, t1: 4100 }] }), style);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].end, 4100 + CAMERA.hold);
});

test('a result already in view does not move the camera', () => {
  const near = { x: 560, y: 280, w: 220, h: 120 };
  const shots = buildShots(timeline({ focus: [click(3000), { kind: 'result', t0: 3180, t1: 3600, rect: near }] }), style);
  assert.equal(shots.length, 1);
  assert.ok(shotContains(shots[0], near, viewport));
  assert.equal(shots[0].end, 3600 + CAMERA.hold);
});

test('a result that covers the page pulls the camera back right after the click', () => {
  const page = { x: 0, y: 0, w: 1280, h: 720 };
  const shots = buildShots(timeline({ focus: [click(3000), { kind: 'result', t0: 3180, t1: 3600, rect: page }] }), style);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].end, 3180);
});

test('after pulling back for a result, the next action is still zoomed', () => {
  const page = { x: 0, y: 0, w: 1280, h: 720 };
  const field = { x: 400, y: 100, w: 500, h: 60 };
  const shots = buildShots(
    timeline({
      focus: [
        { kind: 'key', t0: 3000, t1: 3100 },
        { kind: 'result', t0: 3180, t1: 3400, rect: page },
        { kind: 'type', t0: 3450, t1: 3900, approach: 0, rect: field },
      ],
    }),
    style,
  );
  assert.equal(shots.length, 1);
  assert.equal(shots[0].start, 3450 - CAMERA.lead);
});

test('a brief result is ignored when the next action continues in the same shot', () => {
  const field = { x: 400, y: 250, w: 500, h: 52 };
  const page = { x: 0, y: 100, w: 1200, h: 300 };
  const shots = buildShots(
    timeline({
      focus: [
        { kind: 'type', t0: 3000, t1: 5000, approach: 400, rect: field },
        { kind: 'key', t0: 5400, t1: 5500 },
        { kind: 'result', t0: 5580, t1: 5800, rect: page },
        { kind: 'type', t0: 5800, t1: 7000, approach: 0, rect: field },
      ],
    }),
    style,
  );
  assert.equal(shots.length, 2);
  assert.equal(shots[0].end, shots[1].start, 'no pull-back between the two lines of typing');
});

test('zoom: false on a step keeps the camera wide for it', () => {
  const shots = buildShots(timeline({ focus: [click(3000, button, { zoom: false })] }), style);
  assert.deepEqual(shots, []);
});

test('a scroll pulls back first and a stale shot is not resumed afterwards', () => {
  const shots = buildShots(timeline({ focus: [click(3000)], wide: [{ t0: 3600, t1: 4400, reason: 'scroll' }] }), style);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].end, 3600 - CAMERA.preroll);
});

test('a click that changes the page address stays for the click, then pulls back', () => {
  const shots = buildShots(
    timeline({ focus: [click(3000)], urls: [{ t: 0, url: 'http://x/' }, { t: 3050, url: 'http://x/next' }] }),
    style,
  );
  assert.equal(shots[0].end, 3300);
});

test('the video always ends on the whole page', () => {
  const shots = buildShots(timeline({ duration: 5000, focus: [click(4500)] }), style);
  for (const shot of shots) assert.ok(shot.end <= 5000 - CAMERA.outro);
});

test('sampled motion starts wide, reaches the target, stays inside the page and ends wide', () => {
  const corner = { x: 10, y: 660, w: 200, h: 40 };
  const shots = buildShots(timeline({ focus: [click(4000, corner)] }), style);
  const fps = 30;
  const frames = 20 * fps;
  const camera = sampleCamera(shots, viewport, frames, fps);
  assert.equal(camera.scale.length, frames);
  assert.equal(camera.scale[0], 1);
  assert.ok(Math.abs(camera.scale[Math.round(4.2 * fps)] - 1.6) < 0.05, 'zoomed in by the time of the click');
  assert.ok(camera.scale[frames - 1] < 1.01, 'back to the whole page at the end');
  for (let i = 0; i < frames; i++) {
    const halfW = viewport.width / (2 * camera.scale[i]);
    const halfH = viewport.height / (2 * camera.scale[i]);
    assert.ok(camera.cx[i] >= halfW - 0.01 && camera.cx[i] <= viewport.width - halfW + 0.01, `frame ${i} x in page`);
    assert.ok(camera.cy[i] >= halfH - 0.01 && camera.cy[i] <= viewport.height - halfH + 0.01, `frame ${i} y in page`);
    assert.ok(camera.scale[i] >= 1 && camera.scale[i] <= 1.61);
  }
});

test('camera motion is smooth: it never moves faster than its spring allows', () => {
  const fps = 30;
  const from = { x: 600, y: 300, w: 120, h: 40 };
  const to = { x: 100, y: 600, w: 100, h: 40 };
  const shots = buildShots(timeline({ focus: [click(3000, from), click(5000, to)] }), style);
  const camera = sampleCamera(shots, viewport, 600, fps);
  // A critically damped spring covering distance d peaks at a speed of omega * d / e.
  const peak = (distance) => ((CAMERA.omegaIn * distance) / Math.E / fps) * 1.15;
  const panLimit = peak(Math.abs(from.x + from.w / 2 - (to.x + to.w / 2)));
  const zoomLimit = peak(0.6);
  for (let i = 1; i < 600; i++) {
    assert.ok(Math.abs(camera.scale[i] - camera.scale[i - 1]) <= zoomLimit, `zoom jump at frame ${i}`);
    // While nearly zoomed out the view is pinned to the page centre, so only check when zoomed.
    if (camera.scale[i] > 1.2 && camera.scale[i - 1] > 1.2) {
      assert.ok(Math.abs(camera.cx[i] - camera.cx[i - 1]) <= panLimit, `pan jump at frame ${i}`);
    }
  }
});
