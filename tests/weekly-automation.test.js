'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const AUDIT = path.join(ROOT, 'automation', 'weekly-audit.sh');
const LEARN = path.join(ROOT, 'automation', 'weekly-learn.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-automation-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let seq = 0;
const freshDir = (label) => fs.mkdtempSync(path.join(tmpDir, `${label}-${seq++}-`));

const STUBS = `
claude() { printf '%s\\0' "$@" > "$CLAUDE_CALLS/$(basename "$PWD")"; local ok='{"is_error":false,"result":"report"}'; printf '%s' "\${CLAUDE_OUT-$ok}"; }
pnpm() { printf '%s' "\${PNPM_OUT-}"; return "\${PNPM_RC:-0}"; }
osascript() { printf '%s\\n' "$@" >> "$OSASCRIPT_LOG"; }
`;

// The wrapper exits before the script unless a child bash sees all three stubs, so a real session is never started.
const WRAPPER = `${STUBS}
export -f claude pnpm osascript
[ "$(/bin/bash -c 'type -t claude pnpm osascript')" = "$(printf 'function\\nfunction\\nfunction')" ] || exit 97
/bin/bash "$0" "$@"`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function makeHome(userSettings) {
  const home = freshDir('home');
  writeJson(path.join(home, '.claude', 'settings.json'), userSettings);
  for (const name of ['context-canary.sh', 'weekly-learn.sh']) {
    const file = path.join(home, '.claude', 'automation', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'exit 0\n');
  }
  return home;
}

function makeRepo(name, files = {}) {
  const repo = path.join(freshDir('repos'), name);
  fs.mkdirSync(repo, { recursive: true });
  for (const [relative, value] of Object.entries(files)) writeJson(path.join(repo, relative), value);
  return repo;
}

function runScript(script, args, { home, env = {} }) {
  const calls = freshDir('calls');
  const osascriptLog = path.join(freshDir('osascript'), 'log');
  const result = spawnSync('/bin/bash', ['-c', WRAPPER, script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CALLS: calls, OSASCRIPT_LOG: osascriptLog, ...env },
  });
  const callArgs = (repoName) => {
    const file = path.join(calls, repoName);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\0').slice(0, -1) : null;
  };
  const notifications = fs.existsSync(osascriptLog) ? fs.readFileSync(osascriptLog, 'utf8') : '';
  return { result, calls, callArgs, notifications };
}

function flagValues(args, flag) {
  const start = args.indexOf(flag);
  const rest = args.slice(start + 1);
  const end = rest.findIndex((arg) => arg.startsWith('--'));
  return end === -1 ? rest : rest.slice(0, end);
}

function denyRules(args) {
  assert.equal(args.filter((arg) => arg === '--settings').length, 1);
  return JSON.parse(fs.readFileSync(flagValues(args, '--settings')[0], 'utf8')).permissions.deny;
}

test('a session loads user settings only and every user allow rule reaches it as a deny', () => {
  const home = makeHome({
    permissions: {
      allow: ['Bash(git log:*)', 'Bash(git log -1 && rm x)', 'Bash(git add:*)', 'mcp__x__write', 'Read(~/notes)', 'Grep(src/**)', 'Glob(**/*.ts)'],
    },
  });
  const first = makeRepo('repo-one', { '.claude/settings.local.json': { permissions: { allow: ['Bash(mkdir *)'] } } });
  const second = makeRepo('repo-two', { '.claude/settings.local.json': '{' });

  const { result, callArgs } = runScript(AUDIT, [first, second], { home });

  assert.equal(result.status, 0, result.stderr);
  for (const repoName of ['repo-one', 'repo-two']) {
    const args = callArgs(repoName);
    assert.ok(args, `${repoName} started no session`);
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
    assert.equal(args.filter((arg) => arg === '--disallowedTools').length, 1);
    assert.ok(flagValues(args, '--disallowedTools').includes('Edit'));
    const denied = denyRules(args);
    for (const rule of ['Bash(git log -1 && rm x)', 'Bash(git add:*)', 'mcp__x__write']) {
      assert.ok(denied.includes(rule), `${rule} missing from ${JSON.stringify(denied)}`);
    }
    for (const rule of ['Bash(git log:*)', 'Read(~/notes)', 'Grep(src/**)', 'Glob(**/*.ts)', 'Bash(mkdir *)']) {
      assert.ok(!denied.includes(rule), `${rule} present in ${JSON.stringify(denied)}`);
    }
    assert.match(args[args.indexOf('-p') + 1], /CLAUDE\.md/);
    const scripts = path.join(home, '.claude', 'skills', 'a11y-audit', 'scripts');
    assert.deepEqual(flagValues(args, '--allowedTools'), [
      'Read', 'Grep', 'Glob', 'Skill(delete-audit)', 'Skill(improve-codebase-architecture)', 'Skill(a11y-audit)',
      `Bash(python3 ${scripts}/contrast_checker.py *)`, `Bash(python3 ${scripts}/a11y_scanner.py *)`,
    ]);
  }
});

test('an unreadable user settings file fails every repo without starting a session', () => {
  for (const settings of ['{', { permissions: { allow: [5] } }]) {
    const home = makeHome(settings);
    const first = makeRepo('repo-one');
    const second = makeRepo('repo-two');

    const { result, calls, notifications } = runScript(AUDIT, [first, second], { home });

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(fs.readdirSync(calls), []);
    assert.match(notifications, /repo-one/);
    assert.match(notifications, /repo-two/);
    assert.match(notifications, /unreadable settings/);
  }
});

test('a settings rule of any shape reaches the deny file and never the argument list', () => {
  const rules = [
    '--permission-mode',
    'bypassPermissions',
    'Read\n--dangerously-skip-permissions',
    '\u0000--permission-mode=bypassPermissions',
    'Bash(touch *() *)',
    'mcp__x__*',
  ];
  const repo = makeRepo('repo-shaped');

  const home = makeHome({ permissions: { allow: rules } });

  const shaped = runScript(AUDIT, [repo], { home });

  assert.equal(shaped.result.status, 0, shaped.result.stderr);
  const shapedArgs = shaped.callArgs('repo-shaped');
  assert.deepEqual(denyRules(shapedArgs), rules);

  writeJson(path.join(home, '.claude', 'settings.json'), {});
  const plain = runScript(AUDIT, [repo], { home });

  assert.equal(plain.result.status, 0, plain.result.stderr);
  assert.deepEqual(shapedArgs, plain.callArgs('repo-shaped'));
});

test('a pnpm audit that prints nothing is reported as could not run', () => {
  const home = makeHome({});
  const silent = makeRepo('repo-silent');
  const failing = makeRepo('repo-failing');
  const promptOf = (callArgs, repoName) => {
    const args = callArgs(repoName);
    return args[args.indexOf('-p') + 1];
  };

  const silentRun = runScript(AUDIT, [silent], { home });
  const failingRun = runScript(AUDIT, [failing], { home, env: { PNPM_OUT: '{"advisories":{}}', PNPM_RC: '1' } });

  assert.equal(silentRun.result.status, 0, silentRun.result.stderr);
  assert.match(promptOf(silentRun.callArgs, 'repo-silent'), /pnpm audit could not run/);
  assert.equal(failingRun.result.status, 0, failingRun.result.stderr);
  const failingPrompt = promptOf(failingRun.callArgs, 'repo-failing');
  assert.match(failingPrompt, /Dependency advisories from pnpm audit/);
  assert.doesNotMatch(failingPrompt, /pnpm audit could not run/);
});

test('a run with no repos still notifies', () => {
  const home = makeHome({});

  const { result, notifications } = runScript(AUDIT, [], { home });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(notifications.match(/display notification/g).length, 1);
  assert.match(notifications, /No repos audited/);
});

function makeLearnHome() {
  const home = makeHome({});
  const claudeDir = path.join(home, '.claude');
  fs.copyFileSync(path.join(ROOT, 'automation', 'learn-digest.sh'), path.join(claudeDir, 'automation', 'learn-digest.sh'));
  fs.cpSync(path.join(ROOT, 'hooks', 'lib'), path.join(claudeDir, 'hooks', 'lib'), { recursive: true });
  return home;
}

function learnSession(home, id, minutesAgo) {
  const dir = path.join(home, '.claude', 'projects', '-Users-x-repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const prompts = ['one', 'two', 'three', 'four'].map((text) => ({ type: 'user', message: { content: `prompt ${text}` } }));
  fs.writeFileSync(file, prompts.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const when = new Date(Date.now() - minutesAgo * 60 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

const mtimeNs = (file) => fs.statSync(file, { bigint: true }).mtimeNs;
const digestNames = (home) => {
  const root = path.join(home, '.claude', 'state', 'learn', 'digest');
  const [day] = fs.readdirSync(root);
  return fs.readdirSync(path.join(root, day)).filter((name) => name.endsWith('.md')).sort();
};

test('sessions skipped at the cap are digested by the next run', () => {
  const home = makeLearnHome();
  const oldest = learnSession(home, 'aaa-oldest', 30);
  learnSession(home, 'bbb-middle', 20);
  learnSession(home, 'ccc-newest', 10);
  const cursor = path.join(home, '.claude', 'state', 'learn', 'cursor');

  const first = runScript(LEARN, [], { home, env: { LEARN_DIGEST_SET_CAP: '1' } });

  assert.equal(first.result.status, 0, first.result.stderr);
  assert.deepEqual(digestNames(home), ['aaa-oldest.md']);
  assert.equal(mtimeNs(cursor), mtimeNs(oldest));
  assert.match(first.notifications, /2 sessions deferred/);
  assert.ok(first.callArgs('.claude'), 'the learn session did not run');

  const second = runScript(LEARN, [], { home });

  assert.equal(second.result.status, 0, second.result.stderr);
  assert.deepEqual(digestNames(home), ['bbb-middle.md', 'ccc-newest.md']);
  const sessionsDir = path.join(home, '.claude', 'projects', '-Users-x-repo');
  for (const name of fs.readdirSync(sessionsDir)) {
    assert.ok(mtimeNs(cursor) > mtimeNs(path.join(sessionsDir, name)), `cursor not newer than ${name}`);
  }

  const failHome = makeLearnHome();
  learnSession(failHome, 'aaa-oldest', 30);
  learnSession(failHome, 'bbb-newest', 20);

  const failed = runScript(LEARN, [], { home: failHome, env: { LEARN_DIGEST_SET_CAP: '1', CLAUDE_OUT: '{"is_error":true}' } });

  assert.equal(failed.result.status, 1, failed.result.stderr);
  assert.equal(fs.existsSync(path.join(failHome, '.claude', 'state', 'learn', 'cursor')), false);
});
