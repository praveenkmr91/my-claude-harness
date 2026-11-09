'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'learn-due.sh');

const REPORT = [
  '# Weekly learn 2026-11-09',
  '',
  '## Absorb into CLAUDE.md: first',
  'Session: a.jsonl',
  '',
  '## Absorb into code-craft.md: second',
  'Session: b.jsonl',
  '',
  '## Save feedback_third.md: third',
  'Session: c.jsonl',
  '',
  '## Dropped',
  '- a lesson already covered',
  '',
].join('\n');

const homes = [];
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-due-'));
  homes.push(home);
  return home;
}

function learnDir(home) {
  const dir = path.join(home, '.claude', 'state', 'learn');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(file, seconds) {
  fs.writeFileSync(file, fs.existsSync(file) ? fs.readFileSync(file) : '');
  const t = new Date(seconds * 1000);
  fs.utimesSync(file, t, t);
}

function run(home, input) {
  const res = spawnSync('bash', [HOOK_PATH], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test.after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

test('learn due nudge', async (t) => {
  for (const source of ['startup', 'resume']) {
    await t.test(`${source} fires with the proposal count and report path`, () => {
      const home = makeHome();
      const dir = learnDir(home);
      const report = path.join(dir, '2026-11-09.md');
      fs.writeFileSync(report, REPORT);
      const { code, stdout } = run(home, { source });
      assert.equal(code, 0);
      assert.equal(
        JSON.parse(stdout).systemMessage,
        `Weekly learn report 2026-11-09: 3 proposals at ${report}; run \`/learn report\``,
      );
    });
  }

  await t.test('fires when acked is older than the report', () => {
    const home = makeHome();
    const dir = learnDir(home);
    fs.writeFileSync(path.join(dir, '2026-11-09.md'), REPORT);
    touch(path.join(dir, '2026-11-09.md'), 2000);
    touch(path.join(dir, 'acked'), 1000);
    const { stdout } = run(home, { source: 'startup' });
    assert.match(JSON.parse(stdout).systemMessage, /^Weekly learn report 2026-11-09: 3 proposals/);
  });

  await t.test('quiet when acked is newer than the report', () => {
    const home = makeHome();
    const dir = learnDir(home);
    fs.writeFileSync(path.join(dir, '2026-11-09.md'), REPORT);
    touch(path.join(dir, '2026-11-09.md'), 1000);
    touch(path.join(dir, 'acked'), 2000);
    const { code, stdout } = run(home, { source: 'startup' });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  await t.test('quiet when only a digest file is newer than any report', () => {
    const home = makeHome();
    const dir = learnDir(home);
    fs.writeFileSync(path.join(dir, '2026-11-02.md'), REPORT);
    touch(path.join(dir, '2026-11-02.md'), 1000);
    touch(path.join(dir, 'acked'), 2000);
    const digest = path.join(dir, 'digest', '2026-11-09');
    fs.mkdirSync(digest, { recursive: true });
    touch(path.join(digest, 'x.md'), 3000);
    const { code, stdout } = run(home, { source: 'startup' });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  await t.test('quiet when the only file is a digest', () => {
    const home = makeHome();
    const digest = path.join(learnDir(home), 'digest', '2026-11-09');
    fs.mkdirSync(digest, { recursive: true });
    fs.writeFileSync(path.join(digest, 'x.md'), REPORT);
    const { code, stdout } = run(home, { source: 'startup' });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  await t.test('quiet when state/learn does not exist', () => {
    const { code, stdout } = run(makeHome(), { source: 'startup' });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  await t.test('quiet on source clear', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(learnDir(home), '2026-11-09.md'), REPORT);
    const { code, stdout } = run(home, { source: 'clear' });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  await t.test('silent on empty stdin', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(learnDir(home), '2026-11-09.md'), REPORT);
    const { code, stdout, stderr } = run(home, '');
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });
});
