'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'block-dangerous-git.sh');

function run(command, cwd = '/Users/me/repo') {
  const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ tool_input: { command }, cwd }), encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const decision = (stdout) => stdout && JSON.parse(stdout).hookSpecificOutput.permissionDecision;

test('block dangerous git hook', async (t) => {
  await t.test('quotes an unquoted grep glob without deciding permission', () => {
    for (const [command, quoted] of [
      ['grep -rn foo --include=*.tsx .', "grep -rn foo --include='*.tsx' ."],
      ['cd src && grep -r x --include=*.ts .', "cd src && grep -r x --include='*.ts' ."],
      ['grep -rn foo --exclude=*.min.js --exclude-dir=node_modules .', "grep -rn foo --exclude='*.min.js' --exclude-dir=node_modules ."],
      ['grep -rn foo --include=src/*.ts .', "grep -rn foo --include='src/*.ts' ."],
      ['grep -rn foo --include=*.ts --include=*.tsx src | head', "grep -rn foo --include='*.ts' --include='*.tsx' src | head"],
    ]) {
      const { status, stdout } = run(command);
      assert.equal(status, 0, command);
      const output = JSON.parse(stdout).hookSpecificOutput;
      assert.equal(output.updatedInput.command, quoted);
      assert.equal(output.permissionDecision, undefined, command);
    }
  });

  await t.test('a quoted glob keeps the rest of tool_input and still asks before a PR', () => {
    const res = spawnSync('bash', [HOOK_PATH], {
      input: JSON.stringify({ tool_input: { command: 'grep -r x --include=*.md . && gh pr create --fill', description: 'd', timeout: 5 } }),
      encoding: 'utf8',
    });
    const output = JSON.parse(res.stdout).hookSpecificOutput;
    assert.deepEqual(output.updatedInput, { command: "grep -r x --include='*.md' . && gh pr create --fill", description: 'd', timeout: 5 });
    assert.equal(output.permissionDecision, 'ask');
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
      'git -C /tmp/x push',
      'git -c user.name=x push origin main',
      'git --git-dir=.git push',
      '/usr/bin/git push',
      'FOO=1 git push',
      'sudo -u me git push',
      'xargs -I {} git push',
      'cd repo && git -C . push --force',
      'sh -c "git -C x push"',
      'eval git push',
      'bash <<EOF\ngit push\nEOF',
      'git clean -xfd',
      'git branch -D feature',
      'git checkout -- .',
      'git -C repo restore .',
      'echo "unbalanced; git push',
      'git commit -m "x `git branch -D feat`"',
    ]) {
      assert.equal(run(command).status, 2, command);
    }
  });

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
    const { status, stderr } = run('git add -A');
    assert.equal(status, 2);
    assert.match(stderr, /Do not bulk-stage/);
    assert.match(stderr, /git commit --only/);
  });

  await t.test('git push passes only when the repo origin is on the whitelist', () => {
    const mk = (origin) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-wl-'));
      spawnSync('git', ['init', '-q', dir]);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
      return dir;
    };
    const backup = mk('https://github.com/praveenkmr91/my-claude-harness.git');
    const backupSsh = mk('git@github.com:praveenkmr91/my-claude-harness.git');
    const other = mk('https://github.com/praveenkmr91/my-claude-harness-fork.git');
    const work = mk('https://github.com/additiv/some-app.git');
    try {
      assert.equal(run('git push origin master', backup).status, 0, 'https backup cwd');
      assert.equal(run('git push', backupSsh).status, 0, 'ssh backup cwd');
      assert.equal(run(`git -C ${backup} push origin master`, '/Users/me/repo').status, 0, '-C backup');
      assert.equal(run('git push origin master', other).status, 2, 'near-twin remote name');
      assert.equal(run('git push origin master', work).status, 2, 'work remote');
      assert.equal(run('git push', '/Users/me/not-a-repo').status, 2, 'no repo at cwd');
      assert.equal(run(`sh -c "git -C ${backup} push"`, backup).status, 2, 'wrapper hides the dir');
      assert.equal(run('git commit -m x && git push', backup).status, 0, 'commit and push together in backup');
      assert.equal(run(`git -C ${backup} commit --only hooks/foo.sh -q -m "time to sh out" && git -C ${backup} push origin master`, '/Users/me/repo').status, 0, 'wrapper words inside a pathspec or message');
      assert.equal(run(`git -C ${backup} commit -q -m x && sudo git -C ${backup} push`, '/Users/me/repo').status, 2, 'wrapper at command position after &&');
      assert.equal(run('git -C . push origin master', backup).status, 0, 'relative -C resolves against the session cwd');
      assert.equal(run('git -C . push origin master', work).status, 2, 'relative -C in a work repo stays blocked');
      assert.equal(run(`cd ${backup} && git push`, '/Users/me/repo').status, 2, 'cd hides the dir');
    } finally {
      for (const d of [backup, backupSsh, other, work]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  await t.test('branch -D passes only for the branch of a worktree removed earlier in the same && chain', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-del-'));
    const wt = `${repo}-wt`;
    spawnSync('git', ['init', '-q', repo]);
    spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    spawnSync('git', ['-C', repo, 'branch', 'other']);
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'feat']);
    try {
      assert.equal(run(`git worktree remove ${wt} && git branch -D feat`, repo).status, 0, 'remove then delete its branch');
      assert.equal(run(`git -C ${repo} worktree remove ${wt} && git -C ${repo} branch -D feat`, '/Users/me/repo').status, 0, '-C form');
      assert.equal(run(`git worktree remove ${fs.realpathSync(wt)} && git branch -D feat`, repo).status, 0, 'resolved worktree path');
      assert.equal(run(`git worktree remove ${wt}; git branch -D feat`, repo).status, 2, '; runs the delete even if removal fails');
      assert.equal(run(`git worktree remove --force ${wt} && git branch -D feat`, repo).status, 2, 'forced removal');
      assert.equal(run(`git worktree remove ${wt} && git branch -D other`, repo).status, 2, 'a branch the worktree did not hold');
      assert.equal(run(`git worktree remove ${wt} && git branch -D feat other`, repo).status, 2, 'its branch plus another');
      assert.equal(run('git branch -D feat', repo).status, 2, 'delete without a removal');
      assert.equal(run(`git worktree remove ${repo}-missing && git branch -D feat`, repo).status, 2, 'unknown worktree path');
      assert.equal(run(`git worktree remove ${wt} && git branch -D feat`, '/Users/me/not-a-repo').status, 2, 'no repo at cwd');
    } finally {
      spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});
