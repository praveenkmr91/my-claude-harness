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

  await t.test('a dangerous git command is denied wherever it hides', () => {
    for (const command of [
      'git push',
      'git commit -m x && git push origin main',
      'git commit -m "$(git push)"',
      'git commit -m "x" `git push`',
      'bash -c "git push"',
      'echo "a -m "; git push; echo ""',
      'git commit -m x;git push',
      'git commit -m "x\\"" ; git push ; echo "y"',
      'git commit -m x\ngit push',
      'git commit -m x#;git push',
      'git reset --hard HEAD~1',
      'git commit --no-verify -m x',
    ]) {
      assert.equal(run(command).status, 2, command);
    }
  });

  await t.test('dangerous words inside a commit or PR message are prose', () => {
    for (const command of [
      'git commit -m "hooks: never git push from here"',
      "git commit -m 'avoid reset --hard; use git restore .'",
      'git commit --message="do not git push"',
      'git commit -m "x" -m "never pass --no-verify"',
      "git commit -q --only a.sh -m 'Line one\n\nA local commit is private and git push is denied; so'",
      'gh pr create --title "x" --body "run git push later"',
    ]) {
      assert.notEqual(run(command).status, 2, command);
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
      'git commit -m "x\n\nCo-authored-by: Claude <noreply@anthropic.com>"',
      'git commit -m "x\n\nCo-authored-by: A <a@additiv.com>\nCo-authored-by: Claude <noreply@anthropic.com>"',
    ]) {
      const { status, stdout, stderr } = run(command);
      assert.equal(status, 2, command);
      assert.equal(stdout, '');
      assert.match(stderr, /attribution trailer/);
    }
  });

  await t.test("a teammate's additiv co-author trailer passes", () => {
    const { status, stderr } = run(
      'git commit --amend --no-edit --trailer "Co-authored-by: Ammina Korjenic <ammina.kodro@additiv.com>"',
    );
    assert.equal(status, 0, stderr);
  });

  await t.test('commit -a is denied with or without git flags', () => {
    for (const command of ['git commit -am x', 'git -C /Users/me/repo commit -a -m x']) {
      const { status, stderr } = run(command);
      assert.equal(status, 2, command);
      assert.match(stderr, /Do not commit with -a/);
    }
  });

  await t.test('bulk staging is denied with the explicit-path alternative', () => {
    const { status, stderr } = run('git add -A');
    assert.equal(status, 2);
    assert.match(stderr, /Do not bulk-stage/);
    assert.match(stderr, /git commit --only/);
  });
});
