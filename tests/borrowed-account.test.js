'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'borrowed-account.sh');

function run(configDir, input = JSON.stringify({ prompt: 'hi' })) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

const context = (out) => JSON.parse(out).hookSpecificOutput.additionalContext;

test('borrowed-account hook', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borrowed-account-'));
  const profile = path.join(root, '.claude-willy');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, '.profile-name'), 'willy\n');
  const plain = path.join(root, '.claude');
  fs.mkdirSync(plain);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await t.test('a claude-switch profile injects the borrowed-account context', () => {
    const out = context(run(profile));
    assert.match(out, /^BORROWED ACCOUNT \(willy\)/);
    assert.match(out, /everything is done in his name/);
    assert.match(out, /stop and report instead of posting/);
  });

  await t.test('a config dir without .profile-name stays quiet', () => {
    assert.equal(run(plain), '');
  });

  await t.test('no CLAUDE_CONFIG_DIR stays quiet', () => {
    assert.equal(run(undefined), '');
  });

  await t.test('empty stdin still keys on the env, not the prompt', () => {
    assert.match(context(run(profile, '')), /BORROWED ACCOUNT/);
    assert.equal(run(plain, ''), '');
  });
});
