// Keeps the files that describe the package in step with each other.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../skills/demoreel/scripts/lib/version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const json = (path) => JSON.parse(read(path));

test('every manifest carries the same version', () => {
  assert.equal(json('package.json').version, VERSION);
  assert.equal(json('.claude-plugin/plugin.json').version, VERSION);
  assert.equal(json('.codex-plugin/plugin.json').version, VERSION);
  assert.match(read('skills/demoreel/SKILL.md'), new RegExp(`version: "${VERSION.replaceAll('.', '\\.')}"`));
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${VERSION.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(read('README.md'), new RegExp(`version-${VERSION.replaceAll('.', '\\.')}-`));
});

test('there are no dependencies', () => {
  const pkg = json('package.json');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[key], undefined, `package.json must not have ${key}`);
  }
});

test('the skill uses only portable frontmatter and stays a readable length', () => {
  const skill = read('skills/demoreel/SKILL.md');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(frontmatter, 'SKILL.md starts with frontmatter');
  const keys = [...frontmatter[1].matchAll(/^([a-z-]+):/gm)].map((match) => match[1]);
  // Fields outside this list are rejected by some places that load skills.
  const portable = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
  for (const key of keys) assert.ok(portable.includes(key), `"${key}" is not a portable frontmatter field`);
  assert.ok(keys.includes('name') && keys.includes('description'));
  assert.equal(/^name: (.+)$/m.exec(frontmatter[1])[1], 'demoreel');
  const description = /^description: "([\s\S]*?)"$/m.exec(frontmatter[1])[1];
  assert.ok(description.length <= 1024, `description is ${description.length} characters`);
  assert.ok(skill.split('\n').length < 500, 'SKILL.md is under 500 lines');
});

test('every file the skill and README point to exists', () => {
  for (const file of ['skills/demoreel/SKILL.md', 'README.md', 'CONTRIBUTING.md']) {
    // Links inside code are examples for the reader's own project, not links in this repo.
    const text = read(file).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    const base = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    for (const match of text.matchAll(/\]\(((?!https?:|#|mailto:)[^)#\s]+)(#[^)]*)?\)|(?:src|href)="((?!https?:|#)[^"#]+)"/g)) {
      const target = match[1] || match[3];
      assert.ok(existsSync(`${root}${base}${target}`), `${file} links to ${target}, which does not exist`);
    }
  }
});

test('the example storyboards are valid', async () => {
  const { loadStoryboard } = await import('../skills/demoreel/scripts/lib/storyboard.mjs');
  for (const file of ['examples/lumen/demo.reel.json', 'examples/lumen/phone.reel.json']) {
    const story = loadStoryboard(`${root}${file}`);
    assert.ok(story.steps.length > 3, file);
  }
});

test('the storyboard in the README is the one in the examples folder', () => {
  const readme = read('README.md');
  const block = /```json\n(\{\n  "serve": "\."[\s\S]*?\n\})\n```/.exec(readme);
  assert.ok(block, 'README shows the example storyboard');
  assert.deepEqual(JSON.parse(block[1]), json('examples/lumen/demo.reel.json'));
});

test('the storyboard on the website is the one in the examples folder', () => {
  const page = read('docs/index.html');
  const block = /<code id="storyboard">([\s\S]*?)<\/code>/.exec(page);
  assert.ok(block, 'the page shows the example storyboard');
  assert.deepEqual(JSON.parse(block[1]), json('examples/lumen/demo.reel.json'));
  for (const media of ['media/demo.mp4', 'media/demo.poster.png', 'media/phone.mp4', 'media/phone.poster.png', 'media/logo.png']) {
    assert.ok(page.includes(media) && existsSync(`${root}docs/${media}`), `${media} is used and exists`);
  }
});
