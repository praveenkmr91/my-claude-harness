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
