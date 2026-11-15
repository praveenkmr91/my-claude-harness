'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { HOOK_PATH, tmpDir, joinsFor } = require('./helpers/review-classify');

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
    const run = (prompt) => execFileSync('python3', [HOOK_PATH], { input: JSON.stringify({ prompt }), cwd: dir, encoding: 'utf8' });
    assert.equal(run('review high'), '<review-joins effort=high>\n');
    assert.equal(run('review'), '');
  });
});
