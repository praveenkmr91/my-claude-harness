'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });

// The allowlist in .gitignore is deny-by-default, so a config file added later is silently
// untracked. These assert the two kinds that matter: hand-authored rule docs, and the
// executable surface (hooks, agents) — the things a lost edit actually costs you.
test('config tracking', async (t) => {
  await t.test('every top-level .md is tracked', () => {
    const untracked = fs.readdirSync(ROOT)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => git('ls-files', '--', f).trim() === '');
    assert.deepEqual(untracked, [], `untracked rule docs — re-include them in .gitignore: ${untracked}`);
  });

  await t.test('every hook and agent is tracked', () => {
    const untracked = [];
    for (const dir of ['hooks', 'agents']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = `${dir}/${f}`;
        if (git('ls-files', '--', rel).trim() === '') untracked.push(rel);
      }
    }
    assert.deepEqual(untracked, [], `untracked executable config: ${untracked}`);
  });

  await t.test('no runtime state or transcripts are tracked', () => {
    const tracked = git('ls-files').split('\n').filter(Boolean);
    const leaked = tracked.filter((f) => /^(projects|plugins|security|file-history|paste-cache|backups|cache|debug|todos|shell-snapshots)\//.test(f));
    assert.deepEqual(leaked, [], `runtime state must stay out of git: ${leaked.slice(0, 5)}`);
  });
});
