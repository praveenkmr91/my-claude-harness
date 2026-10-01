'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'inject-once.sh');

const flags = [];
let seq = 0;
const newSession = () => `inject-once-test-${process.pid}-${seq++}`;

test.after(() => {
  for (const flag of flags) fs.rmSync(flag, { force: true });
});

function run(doc, payload) {
  if (payload.session_id) flags.push(`/tmp/claude-inject-${doc}-${payload.session_id}-${payload.agent_id || 'main'}`);
  const res = spawnSync('bash', [HOOK_PATH, doc], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

const call = (sessionId, agentId) => ({ session_id: sessionId, ...(agentId && { agent_id: agentId }), tool_name: 'Agent', tool_input: {} });
const context = (out) => JSON.parse(out).hookSpecificOutput.additionalContext;

test('inject-once hook', async (t) => {
  await t.test('first call injects the named doc', () => {
    const out = context(run('subagent-tiers.md', call(newSession())));
    assert.match(out, /subagent-tiers\.md — injected once/);
    assert.match(out, /\| Explore \| Haiku always/);
  });

  await t.test('later calls in the same thread are silent', () => {
    const sid = newSession();
    run('subagent-tiers.md', call(sid));
    assert.equal(run('subagent-tiers.md', call(sid)), '');
  });

  await t.test('each subagent thread gets its own injection', () => {
    const sid = newSession();
    run('browser-verify.md', call(sid));
    assert.match(context(run('browser-verify.md', call(sid, 'agent-a'))), /browser-verify\.md — injected once/);
    assert.equal(run('browser-verify.md', call(sid, 'agent-a')), '');
  });

  await t.test('different docs flag independently', () => {
    const sid = newSession();
    run('subagent-tiers.md', call(sid));
    assert.match(context(run('browser-verify.md', call(sid))), /browser-verify\.md/);
  });

  await t.test('missing session id is silent', () => {
    assert.equal(run('subagent-tiers.md', { tool_name: 'Agent', tool_input: {} }), '');
  });
});
