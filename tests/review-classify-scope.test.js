'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { HOOK_PATH, tmpDir, env, joinsForEdit } = require('./helpers/review-classify');

test('review-classify scopes the edited file', async (t) => {
  const files = {
    'a.ts': ['export const a = 1;\n', 'export const a = 1;\nexport const a2 = 2;\nexport const a3 = 3;\n'],
    'b.ts': ['export const b = 1;\n', 'export const b = 1;\nexport const b2 = 2;\nexport const b3 = 3;\nexport const b4 = 4;\n'],
  };

  await t.test('payload file_path no longer scopes: the dirty tree stays in scope', () => {
    const out = joinsForEdit({ files, payload: (repo) => ({ tool_input: { file_path: path.join(repo, 'b.ts') } }) });
    assert.match(out, / added=5 /);
  });

  await t.test('payload without file_path leaves the dirty tree in scope', () => {
    assert.match(joinsForEdit({ files }), / added=5 /);
  });

  await t.test('empty stdin exits 0', () => {
    assert.doesNotThrow(() => joinsForEdit({ files, stdin: '' }));
  });
});

test('review-classify comment-only exit', async (t) => {
  const commentOnly = / verb=review lenses=comment-analyzer /;
  const base = 'export const a = 1;\n';
  const joinsAdding = (added, { name = 'session.ts', committed = base } = {}) => joinsForEdit({ files: { [name]: [committed, committed + added] } });

  await t.test('a comment added to a committed risk-named file routes comment-analyzer alone', () => {
    assert.match(joinsAdding('// why\n'), commentOnly);
  });

  await t.test('a wrapped JSX comment added in a .tsx routes comment-analyzer alone', () => {
    assert.match(joinsAdding('{/* a\n b */}\n', { name: 'view.tsx' }), commentOnly);
  });

  const quiet = [
    ['plus one code line', '// why\nexport const b = 2;\n'],
    ['code before a closing comment', '/* a */ foo()\n'],
    ['a lint directive', '// oxlint-disable-next-line\n'],
    ['a multiplication continuation', '  * rate\n'],
    ['a regex literal ending in */', 'const RE = /a*/\n'],
  ];
  for (const [name, added] of quiet) {
    await t.test(`quiet: ${name}`, () => {
      assert.doesNotMatch(joinsAdding(added), / lenses=comment-analyzer /);
    });
  }

  await t.test('quiet: a removed code line', () => {
    const out = joinsForEdit({ files: { 'session.ts': [`${base}export const b = 2;\n`, base] } });
    assert.doesNotMatch(out, / lenses=comment-analyzer /);
  });

  await t.test('quiet: an untracked comment-only file', () => {
    const payload = (repo) => { fs.writeFileSync(path.join(repo, 'notes.ts'), '// why\n'); return {}; };
    const out = joinsForEdit({ files: { 'session.ts': [base, `${base}// why\n`] }, payload });
    assert.doesNotMatch(out, / lenses=comment-analyzer /);
  });
});

test('review-classify review_base', async (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' }).trim();
  const commit = (file, source = 'export const a = 1;\n') => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), source);
    git('add', '.');
    git('commit', '-q', '-m', file);
    return git('rev-parse', '--short', 'HEAD');
  };
  git('init', '-q');
  const root = commit('README.md');
  commit('src/c.ts', 'p.catch(() => null);\n');
  const step1 = commit('src/a.tsx');
  commit('docs/b.md');
  commit('src/d.ts');
  const transcript = path.join(tmpDir, 'since.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: '2020-01-01T00:00:00.000Z' })}\n`);
  const lensesFrom = (review_base, transcript_path = transcript) => execFileSync('python3', [HOOK_PATH], { input: JSON.stringify({ transcript_path, review_base }), cwd: repo, encoding: 'utf8', env }).match(/lenses=(\S+)/)[1].split(',');

  await t.test('lenses come from the delta after the base only', () => {
    assert.ok(!lensesFrom(step1).includes('react-best-practices'));
    assert.ok(lensesFrom(root).includes('react-best-practices'));
  });

  await t.test('content signals come from the delta after the base only', () => {
    assert.ok(!lensesFrom(step1).includes('silent-failure-hunter'));
    assert.ok(lensesFrom(undefined).includes('silent-failure-hunter'));
  });

  await t.test('an unresolvable base falls back to the session scope', () => {
    assert.ok(lensesFrom('deadbee').includes('react-best-practices'));
  });

  const editTranscript = path.join(tmpDir, 'edit.jsonl');
  const editEntry = { type: 'assistant', timestamp: '2020-01-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, 'docs/x.md') } }] } };
  fs.writeFileSync(editTranscript, `${JSON.stringify(editEntry)}\n`);

  await t.test('the base outranks a session edit', () => {
    assert.ok(lensesFrom(root, editTranscript).includes('react-best-practices'));
  });

  await t.test('without a base the session edit scopes the review', () => {
    assert.ok(!lensesFrom(undefined, editTranscript).includes('react-best-practices'));
  });
});

test('review-classify on bytes outside ASCII', async (t) => {
  await t.test('an edited path holding U+00C5 still prints its joins line', () => {
    const name = 'Årsrapport.ts';
    const files = { [name]: ['export const a = 1;\n', 'export const a = b ?? 1;\n'] };
    // The collation crash this guards only exists under a UTF-8 locale.
    const transcript = path.join(tmpDir, 'edit-aring.jsonl');
    const payload = (repo) => {
      const edit = { type: 'assistant', timestamp: '2020-01-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, name), old_string: 'x', new_string: files[name][1] } }] } };
      fs.writeFileSync(transcript, `${JSON.stringify(edit)}\n`);
      return { transcript_path: transcript };
    };
    const out = joinsForEdit({ files, locale: 'en_US.UTF-8', payload });
    assert.match(out, /lenses=\S*silent-failure-hunter/);
  });

  await t.test('a package.json with an invalid UTF-8 byte still yields its test script', () => {
    const manifest = Buffer.from('{"author":"Jos\xe9","scripts":{"test":"vitest"}}', 'latin1');
    const files = { 'package.json': [manifest, manifest], 'a.ts': ['', 'export const a = 1;\n'] };
    assert.match(joinsForEdit({ files }), /lenses=\S*pr-test-analyzer/);
  });

  await t.test('a comment indented with a Unicode space is not a comment-only change', () => {
    const files = { 'a.ts': ['export const a = 1;\n', 'export const a = 1;\n // note\n'] };
    assert.match(joinsForEdit({ files }), /lenses=reuse-analyzer/);
  });
});
