'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'hydrogen-context.sh');
const HYDROGEN_REF = path.resolve(__dirname, '..', 'hydrogen-reference.md');
const FLAG_PREFIX = `claude-hydrogen-ctx-theme-ctx-test-${process.pid}-`;

let seq = 0;
const newSession = () => `theme-ctx-test-${process.pid}-${seq++}`;

function repoWith(dependency) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-ctx-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [dependency]: '1.0.2' } }));
  return dir;
}

const themedRepo = repoWith('@additiv-hydrogen/ui.theme');
const plainRepo = repoWith('react');

test.after(() => {
  for (const name of fs.readdirSync('/tmp')) {
    if (name.startsWith(FLAG_PREFIX)) fs.rmSync(path.join('/tmp', name), { force: true });
  }
  fs.rmSync(themedRepo, { recursive: true, force: true });
  fs.rmSync(plainRepo, { recursive: true, force: true });
});

function run(input) {
  const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8', env: { ...process.env, HYDROGEN_REF } });
  assert.equal(res.status, 0);
  return res.stdout;
}

const call = (sessionId, cwd) =>
  JSON.stringify({ session_id: sessionId, cwd, tool_name: 'Grep', tool_input: { pattern: 'getColor' } });

test('hydrogen context hook', async (t) => {
  await t.test('a call naming getColor injects the Theming section once', () => {
    const sessionId = newSession();
    assert.match(run(call(sessionId, themedRepo)), /## Theming/);
    assert.equal(run(call(sessionId, themedRepo)), '');
  });

  await t.test('a call in a repo without Hydrogen injects nothing', () => {
    assert.equal(run(call(newSession(), plainRepo)), '');
  });

  await t.test('an empty payload passes with no output', () => {
    assert.equal(run(''), '');
  });
});
