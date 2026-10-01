'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'tiers-context.sh');

let seq = 0;
const newSession = () => `tiers-ctx-test-${process.pid}-${seq++}`;

test.after(() => {
  for (let i = 0; i < seq; i++) fs.rmSync(`/tmp/claude-tiers-ctx-tiers-ctx-test-${process.pid}-${i}`, { force: true });
});

function run(payload) {
  const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

const agentCall = (sessionId) => ({ session_id: sessionId, tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'x' } });

test('tiers context hook', async (t) => {
  await t.test('first Agent call injects the tier spec', () => {
    const out = JSON.parse(run(agentCall(newSession())));
    assert.match(out.hookSpecificOutput.additionalContext, /subagent-tiers\.md — injected once/);
    assert.match(out.hookSpecificOutput.additionalContext, /\| Explore \| Haiku always/);
  });

  await t.test('later Agent calls in the same session are silent', () => {
    const sid = newSession();
    run(agentCall(sid));
    assert.equal(run(agentCall(sid)), '');
  });

  await t.test('missing session id is silent', () => {
    assert.equal(run({ tool_name: 'Agent', tool_input: {} }), '');
  });
});
