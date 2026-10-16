'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'commit-trailer-check.sh');
const COMMIT_COMMAND = 'git commit -q --allow-empty -F msg.txt';

// Under the pre-commit hook git exports GIT_INDEX_FILE etc.; inherited, they point the scratch repo at ~/.claude's index.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function run(input) {
  const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const runCommand = (command, cwd) => run(JSON.stringify({ tool_input: { command }, cwd, tool_response: {} }));

test('commit trailer check hook', async (t) => {
  const repoDir = fs.mkdtempSync(os.tmpdir() + '/trailer-');
  const emptyDir = fs.mkdtempSync(os.tmpdir() + '/trailer-');
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'init');

  const commit = (message) => {
    fs.writeFileSync(path.join(repoDir, 'msg.txt'), message);
    git('commit', '-q', '--allow-empty', '-F', 'msg.txt');
  };

  await t.test('a trailer that landed via -F is denied', () => {
    commit('fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const { status, stderr } = runCommand(COMMIT_COMMAND, repoDir);
    assert.equal(status, 2);
    assert.match(stderr, /attribution trailer landed/);
  });

  await t.test("a teammate's additiv co-author trailer passes", () => {
    commit('fix: x\n\nCo-authored-by: Ammina Korjenic <ammina.kodro@additiv.com>');
    const { status, stderr } = runCommand(COMMIT_COMMAND, repoDir);
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  await t.test('a plain message passes', () => {
    commit('fix: x');
    assert.equal(runCommand(COMMIT_COMMAND, repoDir).status, 0);
  });

  await t.test('a non-commit git command reads nothing', () => {
    commit('fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const { status, stdout, stderr } = runCommand('git status', repoDir);
    assert.equal(status, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });

  await t.test('a non-repo cwd and empty input fail open', () => {
    assert.equal(runCommand('git commit -m x', emptyDir).status, 0);
    assert.equal(run('{}').status, 0);
  });

  await t.test('git -C <dir> reads that repo, not cwd', () => {
    commit('fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const { status, stderr } = runCommand(`git -C ${repoDir} commit -q --allow-empty -F msg.txt`, emptyDir);
    assert.equal(status, 2);
    assert.match(stderr, /attribution trailer landed/);
  });
});
