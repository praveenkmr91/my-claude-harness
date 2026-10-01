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

  await t.test('asks when git flags precede commit or a temp path is only an argument', () => {
    for (const command of [
      'git -C /Users/me/repo commit -m x',
      'git -c core.editor=true commit -m x',
      'git --no-pager commit -m x',
      'git commit -F /private/tmp/claude-501/s/msg.txt',
      'git commit --only a -m "see /tmp/ notes"',
      'gh pr create --title x --body-file /tmp/b.md',
      "git -C '/Users/me/my repo' commit -m x",
      'git --git-dir /r/.git --work-tree /r commit -m x',
      'gh -R org/app pr create --title x',
      'git commit -m x\ncd /tmp/y',
      'cd /tmp/x && ls; cd /Users/me/repo && git commit -m x',
    ]) {
      assert.equal(decision(run(command).stdout), 'ask', command);
    }
  });

  await t.test('lets temp-dir commits and non-commit git through silently', () => {
    assert.equal(run('git commit -m x', '/private/tmp/claude-501/scratch/repo').stdout, '');
    assert.equal(run('git commit -m x', '/var/folders/kq/T/tmp.abc').stdout, '');
    assert.equal(run('cd /tmp/fixture && git commit -m x').stdout, '');
    assert.equal(run('git -C /private/tmp/claude-501/s/repo commit -m x').stdout, '');
    assert.equal(run('git status').stdout, '');
    assert.equal(run('git log --grep commit').stdout, '');
    assert.equal(run('git --no-pager log --grep commit').stdout, '');
    assert.equal(run('gh pr view 12').stdout, '');
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
