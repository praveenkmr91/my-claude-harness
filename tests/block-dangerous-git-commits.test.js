'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { HOOK_PATH, env, run } = require('./helpers/block-dangerous-git');

test('block dangerous git hook: commits', async (t) => {
  await t.test('dangerous words in quoted data, heredoc bodies and search patterns pass', () => {
    for (const command of [
      `jq -cn '{tool_input:{command:"git -C /tmp/x push --force origin main"}}'`,
      'echo "git push is denied here"',
      'grep -n "push --force" README.md',
      'git log --grep "reset --hard"',
      "cat <<'EOF' > /tmp/msg.txt\nnever git push; don't reset --hard\nEOF",
      'git push-docs-check',
      'grep -c "Chaining \\`&& git branch -D <branch>\\`" settings.json',
      'git commit -m "allow \\`git branch -D feat\\` after removal"',
    ]) {
      assert.notEqual(run(command).status, 2, command);
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
      'git commit --amend --no-edit --trailer "Co-authored-by: Teammate Example <teammate@additiv.com>"',
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
    for (const command of [
      'git add -A',
      'git -C /tmp/wt add -A',
      'git -C /tmp/wt add -A src package.json',
      'git -C /tmp/wt add .',
      'git --no-pager add --all',
    ]) {
      const { status, stderr } = run(command);
      assert.equal(status, 2, command);
      assert.match(stderr, /Do not bulk-stage/);
      assert.match(stderr, /git commit --only/);
    }
    for (const command of ['git -C /tmp/wt add -- src/a.ts', 'git -C /tmp/wt add src/a.ts', 'git -C /tmp/wt status']) {
      assert.equal(run(command).status, 0, command);
    }
  });

  await t.test('an empty payload passes with no output', () => {
    for (const input of ['{}', '']) {
      const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8', env });
      assert.equal(res.status, 0, JSON.stringify(input));
      assert.equal(res.stdout, '', JSON.stringify(input));
    }
  });
});
