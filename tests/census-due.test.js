'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'census-due.sh');

const homes = [];
function censusDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'census-due-'));
  homes.push(home);
  const dir = path.join(home, '.claude', 'state', 'census');
  fs.mkdirSync(path.join(dir, 'overengineering'), { recursive: true });
  return { home, dir, report: path.join(dir, 'overengineering', 'latest.md') };
}

function touch(file, seconds) {
  fs.writeFileSync(file, '');
  const t = new Date(seconds * 1000);
  fs.utimesSync(file, t, t);
}

function run(home, input) {
  const res = spawnSync('bash', [HOOK_PATH], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return { code: res.status, stdout: res.stdout };
}

test.after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

test('census due reminder', async (t) => {
  for (const source of ['startup', 'resume']) {
    await t.test(`${source} names an unacknowledged report and the ack command`, () => {
      const { home, dir, report } = censusDir();
      touch(report, 2000);
      const { code, stdout } = run(home, { source });
      assert.equal(code, 0);
      assert.ok(stdout.includes(report), stdout);
      assert.ok(stdout.includes(`touch ${dir}/acked`), stdout);
    });
  }

  await t.test('fires when the report is newer than the ack, and stays quiet when the ack is newer', () => {
    const { home, dir, report } = censusDir();
    touch(report, 2000);
    touch(path.join(dir, 'acked'), 1000);
    assert.ok(run(home, { source: 'startup' }).stdout.includes(report));
    touch(path.join(dir, 'acked'), 3000);
    assert.deepEqual(run(home, { source: 'startup' }), { code: 0, stdout: '' });
  });

  await t.test('quiet on a compact start, with no report, and on empty or malformed input', () => {
    const { home, report } = censusDir();
    assert.deepEqual(run(home, { source: 'startup' }), { code: 0, stdout: '' });
    touch(report, 2000);
    assert.deepEqual(run(home, { source: 'compact' }), { code: 0, stdout: '' });
    assert.deepEqual(run(home, ''), { code: 0, stdout: '' });
    assert.deepEqual(run(home, 'not json'), { code: 0, stdout: '' });
  });
});
