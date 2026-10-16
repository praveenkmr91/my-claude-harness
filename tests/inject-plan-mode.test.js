'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'inject-plan-mode.sh');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');

const flags = [];
let seq = 0;
const newSession = () => `inject-plan-mode-test-${process.pid}-${seq++}`;
const flagOf = (sessionId) => `/tmp/claude-plan-mode-${sessionId}`;

test.after(() => {
  for (const flag of flags) fs.rmSync(flag, { force: true });
});

function run(event, payload) {
  if (payload.session_id) flags.push(flagOf(payload.session_id));
  const res = spawnSync('bash', [HOOK_PATH, event], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

const planEdit = (sessionId, file) => ({ session_id: sessionId, tool_name: 'Write', tool_input: { file_path: path.join(PLANS_DIR, file) } });

test('inject-plan-mode hook', async (t) => {
  await t.test('a plan file edit injects plan-mode.md', () => {
    const out = run('PreToolUse', planEdit(newSession(), 'x.md'));
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Current instructions, never a journal/);
  });

  await t.test('a research file edit is silent and leaves no flag', () => {
    const sid = newSession();
    assert.equal(run('PreToolUse', planEdit(sid, 'x.research.md')), '');
    assert.equal(fs.existsSync(flagOf(sid)), false);
  });

  await t.test('empty input exits 0 with no output', () => {
    const res = spawnSync('bash', [HOOK_PATH, 'PreToolUse'], { input: '', encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });
});
