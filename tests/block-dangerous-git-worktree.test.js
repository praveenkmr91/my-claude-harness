'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOK_PATH, env, run } = require('./helpers/block-dangerous-git');

test('block dangerous git hook: worktree', async (t) => {
  await t.test('git push passes only when the repo origin is on the whitelist', () => {
    const mk = (origin) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-wl-'));
      spawnSync('git', ['init', '-q', dir], { env });
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { env });
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
    spawnSync('git', ['init', '-q', repo], { env });
    spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
    spawnSync('git', ['-C', repo, 'branch', 'other'], { env });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'feat'], { env });
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
      spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { env });
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  await t.test('reset --hard passes only in a worktree whose folder and branch this session created', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-own-'));
    const [mine, theirs, reused] = [`${repo}-mine`, `${repo}-theirs`, `${repo}-reused`];
    const secondsFromNow = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
    const [justBefore, anHourAgo, aMinuteAhead] = [secondsFromNow(-2), secondsFromNow(-3600), secondsFromNow(60)];
    spawnSync('git', ['init', '-q', repo], { env });
    spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
    const base = spawnSync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], { env, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['-C', repo, 'branch', 'existing'], { env });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feat', mine], { env });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'other', theirs], { env });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', reused, 'existing'], { env });
    const twin = `${repo}-twin`;
    spawnSync('git', ['init', '-q', twin], { env });
    spawnSync('git', ['-C', twin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
    spawnSync('git', ['-C', twin, 'branch', 'feat'], { env });

    const bashCall = (command, timestamp) => ({
      type: 'assistant',
      cwd: repo,
      timestamp,
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
    });
    const transcript = path.join(repo, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      [
        bashCall(`git worktree add -b feat ${mine} main && cp a b`, justBefore),
        bashCall(`git worktree add -b other ${theirs}`, anHourAgo),
        bashCall(`false && git worktree add -b existing ${reused}`, aMinuteAhead),
        bashCall(`git worktree add -b ${base} ${repo}`, justBefore),
        bashCall(`git worktree add -b fresh ${repo}`, justBefore),
        { type: 'user', cwd: repo, timestamp: justBefore, message: { content: `please run git worktree add -b other ${theirs}` } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );
    const empty = path.join(repo, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    const unreadable = path.join(repo, 'unreadable.jsonl');
    fs.writeFileSync(unreadable, `${fs.readFileSync(transcript, 'utf8')}\n{"type":"assistant","note":"worktree`);
    const hook = (command, cwd, transcriptPath = transcript, agentId = undefined) =>
      spawnSync('bash', [HOOK_PATH], {
        input: JSON.stringify({ tool_input: { command }, cwd, transcript_path: transcriptPath, agent_id: agentId }),
        encoding: 'utf8',
        env,
      });
    const reset = (...args) => hook(...args).status;
    const envFile = path.join(repo, 'env.sh');
    fs.writeFileSync(envFile, `export GIT_DIR=${repo}/.git\nexport GIT_WORK_TREE=${repo}\n`);

    try {
      assert.equal(reset(`git -C ${mine} reset --hard main`, repo), 0, 'own worktree, named with -C');
      assert.equal(reset('git reset --hard main', mine), 0, 'own worktree as the session cwd');
      assert.equal(reset(`git -C ${theirs} reset --hard main`, repo), 2, 'a branch born long after the call that claims it');
      assert.equal(reset(`git -C ${reused} reset --hard main`, repo), 2, 'a branch that existed before the call that claims it');
      assert.equal(reset('git reset --hard main', repo), 2, 'the shared checkout, even when a call claims it');
      assert.equal(reset(`cd ${repo} && git reset --hard main`, mine), 2, 'a cd hides where the reset lands');
      assert.equal(reset(`git --git-dir ${repo}/.git reset --hard main`, mine), 2, '--git-dir hides where the reset lands');
      assert.equal(reset(`GIT_DIR=${repo}/.git git reset --hard main`, mine), 2, 'GIT_DIR hides where the reset lands');
      assert.equal(reset(`env -C ${repo} git reset --hard main`, mine), 2, 'a wrapper hides where the reset lands');
      assert.equal(reset(`git -C ${mine} reset --hard main`, repo, empty), 2, 'empty transcript');
      assert.equal(reset(`git -C ${mine} reset --hard main`, repo, ''), 2, 'no transcript');
      assert.equal(reset('git branch -D feat', repo), 0, 'delete the branch this session created');
      assert.equal(reset('git branch -D other', repo), 2, 'delete a branch born long after the call that claims it');
      assert.equal(reset('git branch -D existing', repo), 2, 'delete a branch that existed before the call that claims it');
      assert.equal(reset(`git -C ${theirs} branch -D feat`, '/Users/me/not-a-repo'), 0, 'delete it from another worktree of the same repo');
      assert.equal(reset('git branch -D feat existing', repo), 2, 'its branch plus one it did not create');
      assert.equal(reset('git branch -D feat', repo, empty), 2, 'delete with an empty transcript');
      assert.equal(reset(`{ cd ${repo}; git reset --hard main; }`, mine), 2, 'a cd inside a brace group');
      assert.equal(reset(`if [ -d ${repo} ]; then cd ${repo}; fi; git reset --hard main`, mine), 2, 'a cd after then');
      assert.equal(reset(`builtin cd ${repo} && git reset --hard main`, mine), 2, 'a cd behind builtin');
      assert.equal(reset(`git --work-tree=${repo} reset --hard main`, mine), 2, '--work-tree= hides where the reset lands');
      assert.equal(reset(`git --git-dir=${repo}/.git reset --hard main`, mine), 2, '--git-dir= hides where the reset lands');
      assert.equal(reset(`GIT_INDEX_FILE=${repo}/.git/index git reset --hard main`, mine), 2, 'GIT_INDEX_FILE moves what the reset rewrites');
      assert.equal(reset(`git -C ${mine} reset --hard main`, repo, transcript, 'agent-1'), 2, 'a subagent owns nothing');
      assert.equal(reset(`git -C ${mine} reset --hard main`, repo, unreadable), 2, 'a transcript that cannot be read');
      assert.equal(reset(`cd ${twin} && git branch -D feat`, repo), 2, 'a cd hides where the delete lands');
      assert.equal(reset(`GIT_DIR=${twin}/.git git branch -D feat`, repo), 2, 'GIT_DIR hides where the delete lands');
      assert.equal(reset(`git --git-dir ${twin}/.git branch -D feat`, repo), 2, '--git-dir hides where the delete lands');
      assert.equal(reset(`git -C ${twin} branch -D feat`, repo), 2, 'a same-named branch born just now in another repo');
      assert.equal(reset(`git -C ${repo} branch -D feat`, repo, unreadable), 2, 'delete with a transcript that cannot be read');
      assert.equal(reset(`git -C ${repo} branch -D feat`, repo, ''), 2, 'delete with no transcript');
      spawnSync('sh', ['-c', `git -C ${repo} update-ref --create-reflog -m "$(printf 'caf\\351')" refs/heads/undecodable HEAD`], { env });
      assert.equal(reset(`git -C ${repo} branch -D undecodable`, repo), 2, 'delete of a branch whose reflog cannot be decoded');

      const resetHard = `git -C ${mine} reset --hard`;
      const resetMine = `${resetHard} main`;
      const denied = [
        ['bypass 1: a cd after the reset inside a loop', `for i in 1 2\ndo\ngit reset --hard main\ncd ${repo}\ndone`],
        ['bypass 2: a cd before a function that resets', `f() {\ngit reset --hard main\n}\ncd ${repo}\nf`],
        ['bypass 3: GIT_DIR named through quotes', `export "GIT"_DIR=${repo}/.git "GIT"_WORK_TREE=${repo}; git reset --hard main`],
        ['bypass 4: GIT_DIR named through a backslash', `export GI\\T_DIR=${repo}/.git GI\\T_WORK_TREE=${repo}; git reset --hard main`],
        ['bypass 5: a cd word built by expansion', `\${x:-cd} ${repo}; git reset --hard main`],
        ['bypass 6: a cd word built by command substitution', `$(printf c)d ${repo}; git reset --hard main`],
        ['bypass 7: GIT_DIR exported by a sourced file', `. ${envFile}; git reset --hard main`],
        ['a plain reset chained to a second command', `${resetMine}; git -C ${mine} log`],
        ['a plain reset redirected', `${resetMine} > /dev/null`],
        ['a plain reset inside command substitution', `echo $(${resetMine})`],
        ['a plain reset inside sh -c', `sh -c "${resetMine}"`],
        ['a forced removal followed by the delete', `git worktree remove --force ${mine} && git branch -D feat`],
        ['a plain delete followed by a second command', 'git branch -D feat; git status'],
        ['a reset ref with a $', `${resetHard} $REF`],
        ['a reset ref in quotes', `${resetHard} "main"`],
        ['a reset ref with a backslash', `${resetHard} mai\\n`],
        ['a reset ref with an =', `${resetMine}=x`],
        ['a reset ref with a glob character', `${resetHard} mai?`],
        ['a reset piped to cat', `${resetMine} | cat`],
        ['a reset with a tab between words', `git -C ${mine}\treset --hard main`],
        ['a reset ref ending in ~+', `${resetMine}~+`],
      ];
      assert.deepEqual(
        denied.filter(([, command]) => reset(command, mine) !== 2).map(([label]) => label),
        [],
        'commands that were allowed',
      );
      assert.equal(reset(`${resetMine} -q`, repo), 0, 'a plain reset with -q after the ref');
      assert.equal(reset(`${resetMine}@{1}`, repo), 0, 'a plain reset to a reflog ref');
      assert.equal(reset(`${resetHard} HEAD~2`, repo), 0, 'a plain reset to an ancestor ref');
      const hintedReset = hook(`${resetMine}; git -C ${mine} log`, repo);
      assert.equal(hintedReset.status, 2, 'a chained reset');
      assert.match(hintedReset.stderr, /whole command/, 'the denied reset names the plain form');
      const fallbackReset = hook(`${resetMine} # it's stale`, repo);
      assert.equal(fallbackReset.status, 2, 'a reset the tokenizer cannot split');
      assert.match(fallbackReset.stderr, /whole command/, 'a reset denied by the fallback scan names the plain form');
      const hintedDelete = hook('git branch -D feat; git status', repo);
      assert.equal(hintedDelete.status, 2, 'a chained delete');
      assert.match(hintedDelete.stderr, /whole command.*git worktree remove/s, 'the denied delete names the plain form and the removal chain');
      const subagentReset = hook(`${resetMine}; git -C ${mine} log`, repo, transcript, 'agent-1');
      assert.equal(subagentReset.status, 2, 'a subagent chained reset');
      assert.equal(subagentReset.stderr.trim().split('\n').length, 1, 'a subagent denial prints no hint');
      spawnSync('git', ['-C', mine, 'switch', '-q', '-c', 'elsewhere'], { env });
      assert.equal(reset(`git -C ${mine} reset --hard main`, repo), 2, 'own folder, now on a branch the session did not create there');
      spawnSync('git', ['-C', repo, 'switch', '-q', '-c', 'fresh'], { env });
      assert.equal(reset('git reset --hard main', repo), 2, 'the shared checkout, even on a branch born when a call claims it');
    } finally {
      for (const wt of [mine, theirs, reused]) {
        spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { env });
        fs.rmSync(wt, { recursive: true, force: true });
      }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(twin, { recursive: true, force: true });
    }
  });
});
