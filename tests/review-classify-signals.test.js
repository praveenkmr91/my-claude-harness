'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cases, lensesFor } = require('./helpers/review-classify');

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

  await t.test('impeccable joins on a stylesheet change', () => {
    assert.ok(lensesFor('.a { color: red; }', { file: 'a.css' }).includes('impeccable'));
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
