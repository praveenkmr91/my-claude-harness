'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'block-dangerous-git.sh');

function run(command, cwd = '/Users/me/repo') {
  const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ tool_input: { command }, cwd }), encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const decision = (stdout) => stdout && JSON.parse(stdout).hookSpecificOutput.permissionDecision;

test('block dangerous git hook', async (t) => {
  await t.test('denies an unquoted grep glob', () => {
    for (const command of [
      'grep -rn foo --include=*.tsx .',
      'cd src && grep -r x --include=*.ts .',
      'grep -rn foo --exclude=*.min.js --exclude-dir=node_modules .',
      'grep -rn foo --include=src/*.ts .',
    ]) {
      const { status, stderr } = run(command);
      assert.equal(status, 2, command);
      assert.match(stderr, /Quote the glob/);
    }
  });

  await t.test('passes quoted, escaped, brace and glob-free forms', () => {
    for (const command of [
      "grep -rn foo --include='*.tsx' .",
      'grep -rn foo --include="*.tsx" .',
      'grep -rn foo --include=\\*.tsx .',
      'grep -rn foo --include=src .',
      'grep -rn foo --exclude-dir={a,b} .',
      'grep -rn foo --exclude-dir=node_modules .',
    ]) {
      assert.equal(run(command).status, 0, command);
    }
  });

  await t.test('asks before a commit or PR from a repo', () => {
    for (const command of ['git commit -m x', 'cd app && git commit --only src/ -m x', 'gh pr create --title x --body y']) {
      const { status, stdout } = run(command);
      assert.equal(status, 0, command);
      assert.equal(decision(stdout), 'ask', command);
    }
  });

  await t.test('lets temp-dir commits and non-commit git through silently', () => {
    assert.equal(run('git commit -m x', '/private/tmp/claude-501/scratch/repo').stdout, '');
    assert.equal(run('cd /tmp/fixture && git commit -m x').stdout, '');
    assert.equal(run('git status').stdout, '');
    assert.equal(run('gh pr view 12').stdout, '');
  });

  await t.test('attribution trailer is denied, not asked', () => {
    const { status, stdout, stderr } = run('git commit -m "x\n\nCo-Authored-By: bot"');
    assert.equal(status, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /attribution trailer/);
  });
});
