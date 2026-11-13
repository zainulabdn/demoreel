import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { expandEnv, normalizeStoryboard } from '../skills/demoreel/scripts/lib/storyboard.mjs';
import { DemoreelError } from '../skills/demoreel/scripts/lib/util.mjs';

const minimal = (extra = {}) => ({ url: 'http://localhost:3000', steps: [{ click: 'Sign in' }], ...extra });

const failsWith = (raw, pattern) => {
  assert.throws(
    () => normalizeStoryboard(raw, '/tmp/project/demo.reel.json'),
    (error) => {
      assert.ok(error instanceof DemoreelError, `expected a DemoreelError, got ${error}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
};

test('fills in sensible defaults', () => {
  const story = normalizeStoryboard(minimal(), '/tmp/project/demo.reel.json');
  assert.equal(story.name, 'demo');
  assert.deepEqual(story.viewport, { width: 1280, height: 720, mobile: false });
  assert.equal(story.scale, 2);
  assert.equal(story.pace, 1);
  assert.equal(story.output.width, 1920);
  assert.equal(story.output.height, 1080);
  assert.equal(story.output.fps, 30);
  assert.deepEqual(story.output.formats, ['mp4', 'gif']);
  // resolve() gives the platform's own form of the path (a drive letter on Windows).
  assert.equal(story.output.dir, resolve('/tmp/project'));
  assert.equal(story.style.frame, 'browser');
  assert.equal(story.style.zoom, 1.6);
  assert.equal(story.hasCaptions, false);
});

test('takes the output name from the file name, or from "name"', () => {
  assert.equal(normalizeStoryboard(minimal(), '/x/onboarding.reel.json').name, 'onboarding');
  assert.equal(normalizeStoryboard(minimal(), '/x/tour.json').name, 'tour');
  assert.equal(normalizeStoryboard(minimal({ name: 'My launch video' }), '/x/a.json').name, 'My-launch-video');
});

test('describes every step in plain words', () => {
  const story = normalizeStoryboard(
    minimal({
      steps: [
        { say: 'Hello' },
        { click: 'New board', nth: 2 },
        { type: 'Launch plan', into: 'Title' },
        { press: 'Mod+K' },
        { scroll: 600 },
        { scroll: 'Pricing' },
        { wait: 500 },
        { select: 'Pakistan', in: 'Country' },
        { drag: 'Card A', to: 'Done' },
        { zoom: 'out' },
        { goto: '/settings' },
      ],
    }),
  );
  assert.deepEqual(
    story.steps.map((step) => step.label),
    [
      'say "Hello"',
      'click "New board"',
      'type "Launch plan" into "Title"',
      'press Mod+K',
      'scroll 600px',
      'scroll "Pricing"',
      'wait 500ms',
      'select "Pakistan" in "Country"',
      'drag "Card A" to "Done"',
      'zoom out',
      'goto /settings',
    ],
  );
  assert.equal(story.steps[1].nth, 2);
  assert.equal(story.hasCaptions, true);
});

test('"zoom" is an option on other steps and an action on its own', () => {
  const story = normalizeStoryboard(
    minimal({ steps: [{ click: 'Save', zoom: false }, { click: 'Open', zoom: 2 }, { zoom: 'Chart', level: 2.5 }, { zoom: 'out' }] }),
  );
  assert.equal(story.steps[0].action, 'click');
  assert.equal(story.steps[0].zoom, false);
  assert.equal(story.steps[1].zoom, 2);
  assert.equal(story.steps[2].action, 'zoom');
  assert.equal(story.steps[2].target, 'Chart');
  assert.equal(story.steps[2].level, 2.5);
  assert.equal(story.steps[3].out, true);
});

test('viewport presets and phone defaults', () => {
  const phone = normalizeStoryboard(minimal({ viewport: 'phone' }));
  assert.deepEqual(phone.viewport, { width: 390, height: 844, mobile: true });
  assert.equal(phone.scale, 3);
  assert.equal(phone.style.frame, 'phone');
  const custom = normalizeStoryboard(minimal({ viewport: { width: 1000, height: 700 } }));
  assert.deepEqual(custom.viewport, { width: 1000, height: 700, mobile: false });
});

test('output sizes are presets or explicit, and always even', () => {
  assert.equal(normalizeStoryboard(minimal({ output: { size: 'vertical' } })).output.height, 1920);
  const odd = normalizeStoryboard(minimal({ output: { size: { width: 1001, height: 701 } } }));
  assert.equal(odd.output.width, 1000);
  assert.equal(odd.output.height, 700);
});

test('"serve" makes the url optional and resolves relative to the storyboard', () => {
  const story = normalizeStoryboard({ serve: './dist', steps: [{ wait: 100 }] }, '/tmp/project/demo.reel.json');
  assert.equal(story.serve, resolve('/tmp/project/dist'));
  assert.equal(story.url, '/');
});

test('rejects mistakes with a message that names the problem', () => {
  failsWith({ steps: [{ click: 'x' }] }, /needs a "url"/);
  failsWith({ url: 'localhost:3000', steps: [{ click: 'x' }] }, /must start with http/);
  failsWith({ url: 'http://x', steps: [] }, /at least one step/);
  failsWith(minimal({ steps: [{ tap: 'x' }] }), /Step 1 has no action/);
  failsWith(minimal({ steps: [{ click: 'a', type: 'b' }] }), /more than one action/);
  failsWith(minimal({ steps: [{ click: 'a', speed: 2 }] }), /does not understand: "speed"/);
  failsWith(minimal({ steps: [{ click: '' }] }), /needs some text/);
  failsWith(minimal({ steps: [{ wait: 'long' }] }), /must be a number/);
  failsWith(minimal({ steps: [{ select: 'A' }] }), /"in" needs some text/);
  failsWith(minimal({ viewport: 'huge' }), /Unknown viewport/);
  failsWith(minimal({ output: { fps: 29 } }), /output\.fps/);
  failsWith(minimal({ output: { formats: ['webm'] } }), /output\.formats/);
  failsWith(minimal({ style: { colour: 'red' } }), /not a style option/);
  failsWith(minimal({ stpes: [] }), /"stpes" is not a storyboard option/);
  failsWith('nope', /must be a JSON object/);
});

test('error hints tell the author what is allowed', () => {
  try {
    normalizeStoryboard(minimal({ steps: [{ tap: 'x' }] }));
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.hint, /goto, click, hover, type/);
  }
});

test('${env:NAME} is filled in from the environment, and never shown in step labels', () => {
  process.env.DEMOREEL_TEST_PASSWORD = 'hunter2-secret';
  try {
    const story = normalizeStoryboard(
      minimal({ steps: [{ type: '${env:DEMOREEL_TEST_PASSWORD}', into: 'Password' }, { goto: '/t/${env:DEMOREEL_TEST_PASSWORD}' }] }),
    );
    assert.equal(story.steps[0].text, 'hunter2-secret');
    assert.equal(story.steps[1].url, '/t/hunter2-secret');
    for (const step of story.steps) assert.ok(!step.label.includes('hunter2'), `label leaks the secret: ${step.label}`);
    assert.equal(story.steps[0].label, 'type "${env:DEMOREEL_TEST_PASSWORD}" into "Password"');
  } finally {
    delete process.env.DEMOREEL_TEST_PASSWORD;
  }
});

test('a missing environment variable is a clear error, not an empty string', () => {
  failsWith(minimal({ steps: [{ type: '${env:DEMOREEL_SURELY_NOT_SET}', into: 'Password' }] }), /DEMOREEL_SURELY_NOT_SET is not set/);
  assert.equal(expandEnv('a ${env:X} b ${env:Y}', 'here', { X: '1', Y: '2' }), 'a 1 b 2');
  assert.equal(expandEnv('costs $5 {env} ${other}', 'here', {}), 'costs $5 {env} ${other}');
});
