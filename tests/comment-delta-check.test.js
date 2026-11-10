'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'comment-delta-check.js');

const MARKER = '// shortcut: neutral800 stands in (docs/tech-debt.md).';

function edit(file_path, new_string, old_string = '') {
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path, old_string, new_string } });
  const res = spawnSync('node', [HOOK_PATH], { input, encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

function write(file_path, content) {
  const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path, content } });
  const res = spawnSync('node', [HOOK_PATH], { input, encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

const context = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext;

test('comment delta check', async (t) => {
  await t.test('one-line marker with no trigger warns without count text', () => {
    const out = context(edit('/repo/src/theme.ts', MARKER));
    assert.match(out, /theme\.ts adds a shortcut: marker with no upgrade trigger/);
    assert.doesNotMatch(out, /comment lines to/);
  });

  await t.test('two-line marker naming a trigger gives count text only', () => {
    const out = context(edit('/repo/src/theme.ts', `${MARKER}\n// until a token lands.`));
    assert.match(out, /added 2 comment lines to theme\.ts/);
    assert.doesNotMatch(out, /shortcut: marker/);
  });

  await t.test('JSX block-comment marker warns', () => {
    const out = context(edit('/repo/src/get-in-touch.tsx', '{/* shortcut: 18 is off the type scale (docs/tech-debt.md). */}'));
    assert.match(out, /get-in-touch\.tsx adds a shortcut: marker with no upgrade trigger/);
  });

  await t.test('code change beside an existing marker stays quiet', () => {
    const out = edit('/repo/src/theme.ts', `const tone = 'neutral700'; ${MARKER}`, `const tone = 'neutral800'; ${MARKER}`);
    assert.equal(out, '');
  });

  await t.test('two plain comment lines give count text only', () => {
    const out = context(edit('/repo/src/theme.ts', '// a\n// b'));
    assert.match(out, /added 2 comment lines/);
    assert.doesNotMatch(out, /shortcut: marker/);
  });

  await t.test('a leading # counts as a comment in shell files only', () => {
    assert.equal(edit('/repo/src/layout.css', '#header { color: red; }\n#footer { color: blue; }'), '');
    assert.equal(edit('/repo/src/store.ts', '  #count = 0;\n  #items = [];'), '');
    assert.match(context(edit('/repo/scripts/build.sh', '# a\n# b')), /added 2 comment lines to build\.sh/);
  });

  await t.test('both warnings arrive in one parseable JSON line', () => {
    const stdout = edit('/repo/src/theme.ts', `${MARKER}\n// see the token table.`);
    assert.equal(stdout.trim().split('\n').length, 1);
    const [shortcut, count] = context(stdout).split('\n');
    assert.match(shortcut, /shortcut: marker with no upgrade trigger/);
    assert.match(count, /added 2 comment lines/);
  });

  await t.test('a .vue path is scanned', () => {
    assert.match(context(edit('/repo/src/card.vue', MARKER)), /card\.vue adds a shortcut: marker/);
  });

  await t.test('a Write tool call warns on a marker with no trigger', () => {
    assert.match(context(write('/repo/src/theme.ts', MARKER)), /theme\.ts adds a shortcut: marker with no upgrade trigger/);
  });

  await t.test('a .md path is not scanned', () => {
    assert.equal(edit('/repo/docs/notes.md', MARKER), '');
  });

  await t.test('empty stdin exits 0 with no output', () => {
    const res = spawnSync('node', [HOOK_PATH], { input: '', encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });
});
