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

  await t.test('asks before a PR, whatever flags precede it', () => {
    for (const command of ['gh pr create --title x --body y', 'gh pr create --title x --body-file /tmp/b.md', 'gh -R org/app pr create --title x', 'cd app && gh pr create --fill']) {
      const { status, stdout } = run(command);
      assert.equal(status, 0, command);
      assert.equal(decision(stdout), 'ask', command);
    }
  });

  await t.test('local commits and non-PR git run silently', () => {
    for (const command of [
      'git commit -m x',
      'git commit --only src/ -m x',
      'git -C /Users/me/repo commit -F /private/tmp/claude-501/s/msg.txt',
      'git status',
      'git log --grep commit',
      'gh pr view 12',
      'gh -R org/app pr list',
    ]) {
      const { status, stdout } = run(command);
      assert.equal(status, 0, command);
      assert.equal(stdout, '', command);
    }
  });

  await t.test('attribution trailer is denied, not asked', () => {
    for (const command of [
      'git commit -m "x\n\nCo-Authored-By: bot"',
      'git -C /Users/me/repo commit -m "x\n\nCo-Authored-By: bot"',
      'gh -R org/app pr edit 3 --body "Generated with a tool"',
    ]) {
      const { status, stdout, stderr } = run(command);
      assert.equal(status, 2, command);
      assert.equal(stdout, '');
      assert.match(stderr, /attribution trailer/);
    }
  });

  await t.test('commit -a is denied with or without git flags', () => {
    for (const command of ['git commit -am x', 'git -C /Users/me/repo commit -a -m x']) {
      const { status, stderr } = run(command);
      assert.equal(status, 2, command);
      assert.match(stderr, /Do not commit with -a/);
    }
  });
});
