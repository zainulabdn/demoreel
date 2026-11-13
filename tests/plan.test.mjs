import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorAt, planMove } from '../skills/demoreel/scripts/lib/cursorpath.mjs';
import { parseKeyCombo } from '../skills/demoreel/scripts/lib/page.mjs';
import { bitrateFor, buildPlan, computeLayout, displayUrl, sheetMoments } from '../skills/demoreel/scripts/lib/plan.mjs';
import { FRAMES, SIZES, VIEWPORTS, normalizeStoryboard } from '../skills/demoreel/scripts/lib/storyboard.mjs';
import { seededRandom } from '../skills/demoreel/scripts/lib/util.mjs';

const story = (extra = {}) => normalizeStoryboard({ url: 'http://localhost:3000', steps: [{ click: 'Go' }], ...extra }, '/tmp/p/demo.reel.json');

test('the window always fits inside the picture, for every frame, size and viewport', () => {
  for (const frame of FRAMES) {
    for (const size of Object.keys(SIZES)) {
      for (const viewportName of Object.keys(VIEWPORTS)) {
        for (const captions of [false, true]) {
          const s = story({ viewport: viewportName, output: { size }, style: { frame } });
          const layout = computeLayout(s.output, s.viewport, s.style, captions);
          const { window: win, content } = layout;
          const where = `${frame}/${size}/${viewportName}/captions=${captions}`;
          assert.ok(win.x >= 0 && win.y >= 0, `${where}: window starts inside`);
          assert.ok(win.x + win.w <= layout.width && win.y + win.h <= layout.height, `${where}: window ends inside`);
          assert.ok(content.w > 100 && content.h > 100, `${where}: content has a usable size`);
          const aspect = content.w / content.h;
          const expected = s.viewport.width / s.viewport.height;
          assert.ok(Math.abs(aspect - expected) / expected < 0.01, `${where}: page is not stretched`);
          if (captions && frame !== 'none') {
            assert.ok(layout.caption.cy > win.y + win.h, `${where}: captions sit below the window`);
            assert.ok(layout.caption.cy < layout.height, `${where}: captions are on the picture`);
          }
        }
      }
    }
  }
});

test('the browser frame has a bar and the bare frame fills the picture', () => {
  const s = story();
  assert.ok(computeLayout(s.output, s.viewport, s.style, false).bar.h > 0);
  const bare = story({ style: { frame: 'none' }, viewport: { width: 1280, height: 720 } });
  const layout = computeLayout(bare.output, bare.viewport, bare.style, false);
  assert.equal(layout.content.w, 1920);
  assert.equal(layout.content.h, 1080);
  assert.equal(layout.window.radius, 0);
});

test('displayUrl shows a clean address, optionally with a custom host', () => {
  assert.equal(displayUrl('http://127.0.0.1:5173/'), '127.0.0.1:5173');
  assert.equal(displayUrl('http://127.0.0.1:5173/settings/team?tab=1', 'acme.app'), 'acme.app/settings/team');
  assert.equal(displayUrl('not a url', 'acme.app'), 'acme.app');
});

const sampleTimeline = () => ({
  version: 1,
  viewport: { width: 1280, height: 720, mobile: false, scale: 2 },
  duration: 6000,
  frames: [0, 500, 1000, 2500, 5900].map((t, i) => ({ t, file: `${String(i).padStart(6, '0')}.jpg` })),
  cursor: [[0, 800, 400], [1000, 800, 400], [2000, 400, 200], [6000, 400, 200]],
  cursorKinds: [{ t: 0, kind: 'default' }, { t: 1900, kind: 'pointer' }],
  clicks: [{ t: 2200, x: 400, y: 200 }],
  focus: [{ kind: 'click', t0: 2200, t1: 2350, approach: 1000, rect: { x: 350, y: 180, w: 100, h: 40 } }],
  wide: [],
  captions: [{ t0: 300, t1: 6000, text: 'Hello' }],
  urls: [{ t: 0, url: 'http://127.0.0.1:4000/' }],
  steps: [{ index: 0, label: 'click "Go"', t0: 1000, t1: 3000 }],
});

test('a plan has one entry per output frame for every track', () => {
  const plan = buildPlan(sampleTimeline(), story({ displayUrl: 'acme.app' }));
  assert.equal(plan.fps, 30);
  assert.equal(plan.frameCount, 180);
  for (const key of ['src', 'scale', 'cx', 'cy', 'cursorX', 'cursorY', 'cursorKind', 'press', 'cursorAlpha']) {
    assert.equal(plan.track[key].length, plan.frameCount, key);
  }
  assert.equal(plan.urls[0].text, 'acme.app');
  assert.equal(plan.frames.length, 5);
});

test('each output frame shows the latest captured frame, never a future one', () => {
  const plan = buildPlan(sampleTimeline(), story());
  const times = sampleTimeline().frames.map((frame) => frame.t);
  for (let i = 0; i < plan.frameCount; i++) {
    const t = (i * 1000) / plan.fps;
    const index = plan.track.src[i];
    assert.ok(times[index] <= t, `frame ${i} shows a frame from the future`);
    if (index + 1 < times.length) assert.ok(times[index + 1] > t, `frame ${i} is not the latest`);
    if (i > 0) assert.ok(plan.track.src[i] >= plan.track.src[i - 1], 'never goes backwards');
  }
});

test('the cursor is pressed at the click and at rest away from it', () => {
  const plan = buildPlan(sampleTimeline(), story());
  const at = (ms) => plan.track.press[Math.round((ms * plan.fps) / 1000)];
  assert.equal(at(1000), 0);
  assert.ok(at(2200) > 0.9);
  assert.equal(at(3000), 0);
  assert.equal(plan.track.cursorKind[0], 0);
  assert.equal(plan.track.cursorKind[plan.frameCount - 1], 1);
});

test('long videos get a lower bitrate so the MP4 stays under the size limit', () => {
  const output = story().output;
  assert.equal(output.maxMB, 9.5);
  const short = bitrateFor(output, 10_000);
  assert.equal(short.capped, false);
  const long = bitrateFor(output, 60_000);
  assert.equal(long.capped, true);
  assert.ok(long.bitrate < short.bitrate);
  assert.ok((long.bitrate * 60) / 8 / 1_000_000 <= 9.5, 'a full minute at this rate fits in the limit');
  assert.ok(bitrateFor(output, 3_600_000).bitrate >= 600_000, 'never below a watchable floor');
  const unlimited = bitrateFor(story({ output: { maxMB: 0 } }).output, 600_000);
  assert.equal(unlimited.capped, false);
  assert.equal(unlimited.bitrate, short.bitrate);
});

test('encode settings scale with the output', () => {
  const small = buildPlan(sampleTimeline(), story({ output: { size: '720p', quality: 'small' } }));
  const large = buildPlan(sampleTimeline(), story({ output: { size: '1080p', quality: 'high' } }));
  assert.ok(large.encode.bitrate > small.encode.bitrate * 3);
  assert.match(large.encode.codecs[0], /^avc1\.6400/);
  assert.equal(large.encode.gif.width, 960);
  assert.equal(large.encode.gif.height % 2, 0);
  assert.equal(large.encode.gif.every, 2);
});

test('the contact sheet shows the end of each step plus the end, thinned when there are many', () => {
  const few = sheetMoments({ steps: [{ index: 0, label: 'a', t1: 1000 }, { index: 1, label: 'b', t1: 2000 }] }, 100, 30);
  assert.deepEqual(few.map((m) => m.label), ['1. a', '2. b', 'end']);
  assert.equal(few[0].frame, 30);
  const many = sheetMoments({ steps: Array.from({ length: 40 }, (_, i) => ({ index: i, label: 's', t1: i * 100 })) }, 200, 30);
  assert.equal(many.length, 16);
  assert.equal(many.at(-1).label, 'end');
});

test('cursor moves start and end exactly on target and take a human amount of time', () => {
  const random = seededRandom(7);
  const move = planMove({ x: 100, y: 100 }, { x: 900, y: 500 }, random);
  assert.deepEqual(move.at(0), { x: 100, y: 100 });
  assert.deepEqual(move.at(1), { x: 900, y: 500 });
  assert.ok(move.duration >= 320 && move.duration <= 1000);
  const short = planMove({ x: 100, y: 100 }, { x: 130, y: 100 }, random);
  assert.ok(short.duration < move.duration);
  assert.equal(planMove({ x: 5, y: 5 }, { x: 5, y: 5 }, random).duration, 0);
});

test('the same seed gives the same path', () => {
  const a = planMove({ x: 0, y: 0 }, { x: 500, y: 300 }, seededRandom(42)).at(0.5);
  const b = planMove({ x: 0, y: 0 }, { x: 500, y: 300 }, seededRandom(42)).at(0.5);
  assert.deepEqual(a, b);
});

test('cursorAt interpolates between recorded samples', () => {
  const samples = [[0, 0, 0], [100, 100, 50], [200, 100, 50]];
  assert.deepEqual({ ...cursorAt(samples, 50), index: undefined }, { x: 50, y: 25, index: undefined });
  assert.equal(cursorAt(samples, -10).x, 0);
  assert.equal(cursorAt(samples, 999).x, 100);
  assert.equal(cursorAt([], 10).x, 0);
});

test('key names are understood the way people write them', () => {
  assert.deepEqual(parseKeyCombo('Enter', 'darwin'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r', modifiers: 0 });
  const palette = parseKeyCombo('Mod+K', 'darwin');
  assert.equal(palette.modifiers, 4);
  assert.equal(palette.code, 'KeyK');
  assert.equal(palette.text, undefined, 'a shortcut types nothing');
  assert.equal(parseKeyCombo('Mod+K', 'linux').modifiers, 2);
  assert.equal(parseKeyCombo('cmd+shift+p', 'darwin').modifiers, 12);
  assert.equal(parseKeyCombo('esc').key, 'Escape');
  assert.equal(parseKeyCombo('Shift+a').text, 'A');
  assert.equal(parseKeyCombo('a').text, 'a');
  assert.throws(() => parseKeyCombo('Hyper+K'), /not a modifier/);
  assert.throws(() => parseKeyCombo('Mod'), /needs a key/);
  assert.throws(() => parseKeyCombo('Launch'), /not a key/);
});

test('a mouse cursor is always visible; a touch dot appears to tap and fades when idle', () => {
  const mouse = buildPlan(sampleTimeline(), story());
  assert.equal(mouse.style.cursorKind, 'arrow');
  assert.ok(mouse.track.cursorAlpha.every((alpha) => alpha === 1));

  const touch = buildPlan({ ...sampleTimeline(), viewport: { width: 390, height: 844, mobile: true, scale: 3 } }, story({ viewport: 'phone' }));
  assert.equal(touch.style.cursorKind, 'touch');
  const at = (ms) => touch.track.cursorAlpha[Math.round((ms * touch.fps) / 1000)];
  assert.equal(at(1500), 1, 'visible while moving to the target');
  assert.equal(at(2200), 1, 'visible at the tap');
  assert.equal(at(4500), 0, 'gone two seconds after the tap');
  assert.equal(buildPlan(sampleTimeline(), story({ style: { cursor: { kind: 'touch' } } })).style.cursorKind, 'touch');
});

test('tall videos get a narrower GIF by default', () => {
  assert.equal(story({ output: { size: 'vertical' } }).output.gif.width, 540);
  assert.equal(story({ output: { size: 'vertical', gif: { width: 720 } } }).output.gif.width, 720);
  assert.equal(story().output.gif.width, 960);
});
