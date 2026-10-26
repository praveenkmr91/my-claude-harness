'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'review-classify.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-classify-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function lensesFor(source, { packageJson, file = 'src.ts' } = {}) {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, file), source);
  if (packageJson) fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(packageJson));
  const out = execFileSync('bash', [HOOK_PATH], { input: '{}', cwd: repo, encoding: 'utf8' });
  return out.match(/lenses=(\S+)/)[1].split(',');
}

// Under the pre-commit hook git exports GIT_INDEX_FILE etc.; inherited, they point the scratch repo at ~/.claude's index.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function joinsForEdit({ files, payload = () => ({}), stdin }) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env });
  git('init', '-q');
  for (const [name, [committed]] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), committed);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  for (const [name, [, modified]] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), modified);
  const input = stdin ?? JSON.stringify(payload(repo));
  return execFileSync('bash', [HOOK_PATH], { input, cwd: repo, encoding: 'utf8', env });
}

const cases = [
  ['silent-failure-hunter', 'try { f() } catch (e) {}', 'if (a || b) run(); const v = a?.b;'],
  ['silent-failure-hunter', 'const v = a ?? 1; const w = b || [];', 'const v = a?.b;'],
  ['type-design-analyzer', 'export type Foo = { a: string };\ninterface Bar {}', 'const type = 1;'],
  ['comment-analyzer', '// one\n// two\n/** three */\nconst a = 1;', '// one\n// two\nconst a = 1;'],
  ['modern-ts-analyzer', 'var x = 1; if (a.indexOf(b) !== -1) {}', 'const isVar = 1; const avar = 2;'],
];

test('review-classify content signals', async (t) => {
  for (const [lens, hit, miss] of cases) {
    await t.test(`${lens}: joins on ${JSON.stringify(hit)}, not on ${JSON.stringify(miss)}`, () => {
      assert.ok(lensesFor(hit).includes(lens));
      assert.ok(!lensesFor(miss).includes(lens));
    });
  }

  await t.test('ignores signal text inside test files', () => {
    assert.ok(!lensesFor('p.catch(() => null);', { file: 'api.test.ts' }).includes('silent-failure-hunter'));
  });

  await t.test('auto-bundles carry only their own members', () => {
    const risk = lensesFor('export const a = 1;', { file: 'session.ts' });
    assert.ok(risk.includes('adversarial-reviewer') && risk.includes('security-review'));
    assert.ok(!risk.includes('silent-failure-hunter') && !risk.includes('type-design-analyzer'));
    const bulk = lensesFor(Array.from({ length: 200 }, (_, i) => `export const a${i} = ${i};\n`).join(''));
    assert.ok(bulk.includes('delete-list'));
    for (const lens of ['shortcut-debt', 'comment-analyzer', 'modern-ts-analyzer']) assert.ok(!bulk.includes(lens));
  });

  await t.test('pr-test-analyzer: joins only when the repo has a real test script', () => {
    const source = 'export const a = 1;';
    assert.ok(lensesFor(source, { packageJson: { scripts: { test: 'vitest' } } }).includes('pr-test-analyzer'));
    assert.ok(!lensesFor(source, { packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } }).includes('pr-test-analyzer'));
    assert.ok(!lensesFor(source).includes('pr-test-analyzer'));
  });
});

function joinsFor(prompt, { source } = {}) {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (source !== undefined) fs.writeFileSync(path.join(repo, 'src.ts'), source);
  return execFileSync('bash', [HOOK_PATH], { input: JSON.stringify({ prompt }), cwd: repo, encoding: 'utf8' });
}

test('review-classify scopes the edited file', async (t) => {
  const files = {
    'a.ts': ['export const a = 1;\n', 'export const a = 1;\nexport const a2 = 2;\nexport const a3 = 3;\n'],
    'b.ts': ['export const b = 1;\n', 'export const b = 1;\nexport const b2 = 2;\nexport const b3 = 3;\nexport const b4 = 4;\n'],
  };

  await t.test('payload file_path scopes the first edit to that file', () => {
    const out = joinsForEdit({ files, payload: (repo) => ({ tool_input: { file_path: path.join(repo, 'b.ts') } }) });
    assert.match(out, / added=3 /);
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
  const lensesFrom = (review_base, transcript_path = transcript) => execFileSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path, review_base }), cwd: repo, encoding: 'utf8', env }).match(/lenses=(\S+)/)[1].split(',');

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

test('review-classify effort level', async (t) => {
  const source = 'export const a = 1;';
  const stated = [
    ['review high', 'high'], ['effort=low', 'low'], ['battery at max effort', 'high'],
    ['Review xhigh.', 'high'], ['code review medium please', 'medium'], ['effort: Low', 'low'],
    ['review high: the auth flow', 'high'], ['high-effort review please', 'high'],
  ];
  for (const [prompt, level] of stated) {
    await t.test(`${JSON.stringify(prompt)} → effort=${level}`, () => {
      assert.match(joinsFor(prompt, { source }), new RegExp(` effort=${level}>$`, 'm'));
    });
  }

  for (const prompt of ['review the high-risk path', 'review the high efforts page', 'review high-risk code', 'code-review --max-findings all', 'review, low priority', 'review max-width styles', 'review']) {
    await t.test(`${JSON.stringify(prompt)} → no effort`, () => {
      const out = joinsFor(prompt, { source });
      assert.match(out, /verb=review /);
      assert.doesNotMatch(out, /effort=/);
    });
  }

  await t.test('empty scope keeps a stated level and stays silent without one', () => {
    assert.equal(joinsFor('review high'), '<review-joins effort=high>\n');
    assert.equal(joinsFor('review'), '');
  });

  await t.test('non-git dir keeps a stated level', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'plain-'));
    const run = (prompt) => execFileSync('bash', [HOOK_PATH], { input: JSON.stringify({ prompt }), cwd: dir, encoding: 'utf8' });
    assert.equal(run('review high'), '<review-joins effort=high>\n');
    assert.equal(run('review'), '');
  });
});
