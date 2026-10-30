'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'opus-write-nudge.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-write-nudge-'));
const transcripts = {};
for (const [tier, model] of [['opus', 'claude-opus-5'], ['sonnet', 'claude-sonnet-5'], ['fable', 'claude-fable-5-1']]) {
  transcripts[tier] = path.join(tmpDir, `${tier}.jsonl`);
  fs.writeFileSync(transcripts[tier], JSON.stringify({ type: 'assistant', message: { model } }));
}
transcripts.quoted = path.join(tmpDir, 'quoted.jsonl');
fs.writeFileSync(transcripts.quoted, [
  { type: 'user', message: { content: [{ type: 'tool_result', content: '"subagent_type":"implementer"' }] } },
  { type: 'assistant', message: { model: 'claude-opus-5' } },
].map((e) => JSON.stringify(e)).join('\n'));

const OPUS_LINE = { type: 'assistant', message: { model: 'claude-opus-5' } };
const userLine = (content) => ({ type: 'user', message: { content } });
for (const [name, entries] of Object.entries({
  opusNoDispatch: [userLine('fix the typo'), OPUS_LINE],
  opusDispatchedThisTurn: [userLine('go'), { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'implementer' } }] } }, OPUS_LINE],
  opusDispatchedPriorTurn: [{ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'implementer' } }] } }, userLine('next'), OPUS_LINE],
  sonnetTyped: [userLine('go'), { type: 'assistant', message: { model: 'claude-sonnet-5' } }],
})) {
  transcripts[name] = path.join(tmpDir, `${name}.jsonl`);
  fs.writeFileSync(transcripts[name], entries.map((e) => JSON.stringify(e)).join('\n'));
}

let seq = 0;
const RUN = crypto.randomBytes(4).toString('hex');
const newSession = () => `nudge-test-${process.pid}-${RUN}-${seq++}`;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run({ file, tier = 'opus', sessionId, agentId, transcriptPath }) {
  const payload = {
    session_id: sessionId,
    agent_id: agentId,
    transcript_path: transcriptPath === undefined ? transcripts[tier] : transcriptPath,
    tool_input: { file_path: file },
  };
  const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr };
}

test('opus write nudge', async (t) => {
  await t.test('fable session blocks every source write, no dispatch needed', () => {
    const { code, stderr } = run({ sessionId: newSession(), tier: 'fable', file: '/tmp/a.tsx' });
    assert.equal(code, 2);
    assert.match(stderr, /Fable never writes code/);
  });

  await t.test('fable session stays blocked after implementer was dispatched', () => {
    const fableDispatched = path.join(tmpDir, 'fable-dispatched.jsonl');
    fs.writeFileSync(fableDispatched, [
      { type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'implementer' } }] } },
      { type: 'assistant', message: { model: 'claude-fable-5-1' } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    assert.equal(run({ sessionId: newSession(), transcriptPath: fableDispatched, file: '/tmp/a.tsx' }).code, 2);
  });

  await t.test('fable session writes source when the last typed prompt carries [tier-override:]', () => {
    const FABLE_LINE = { type: 'assistant', message: { model: 'claude-fable-5-1' } };
    const write = (name, entries) => {
      const p = path.join(tmpDir, `${name}.jsonl`);
      fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
      return run({ sessionId: newSession(), transcriptPath: p, file: '/tmp/a.tsx' }).code;
    };
    assert.equal(write('fableOverride', [FABLE_LINE, userLine('[tier-override: harness hook edit] go'), FABLE_LINE]), 0);
    assert.equal(write('fableOverrideBlocks', [FABLE_LINE, userLine([{ type: 'text', text: 'go\n[tier-override: harness hook edit]' }]), FABLE_LINE]), 0);
    assert.equal(write('fableOverrideStale', [FABLE_LINE, userLine('[tier-override: harness hook edit] go'), FABLE_LINE, userLine('now the test file'), FABLE_LINE]), 2);
    assert.equal(write('fableOverrideInToolResult', [FABLE_LINE, userLine([{ type: 'tool_result', content: '[tier-override: x]' }]), FABLE_LINE]), 2);
    assert.equal(write('fableOverrideInMeta', [FABLE_LINE, { type: 'user', isMeta: true, message: { content: '[tier-override: x]' } }, FABLE_LINE]), 2);
  });

  await t.test('fable session still writes docs and config directly', () => {
    assert.equal(run({ sessionId: newSession(), tier: 'fable', file: '/tmp/notes.md' }).code, 0);
    assert.equal(run({ sessionId: newSession(), tier: 'fable', file: '/tmp/settings.json' }).code, 0);
  });

  await t.test('blocks the first source write of an opus turn with no implementer dispatch', () => {
    const { code, stderr } = run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: '/tmp/a.tsx' });
    assert.equal(code, 2);
    assert.match(stderr, /implementer/);
    assert.match(stderr, /Do not retry this write/);
    assert.match(stderr, /tier-override/);
  });

  await t.test('a plain retry stays blocked', () => {
    const sessionId = newSession();
    assert.equal(run({ sessionId, transcriptPath: transcripts.opusNoDispatch, file: '/tmp/a.tsx' }).code, 2);
    assert.equal(run({ sessionId, transcriptPath: transcripts.opusNoDispatch, file: '/tmp/b.tsx' }).code, 2);
  });

  await t.test('silent once implementer was dispatched this turn', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusDispatchedThisTurn, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('a dispatch before the last typed prompt does not carry over', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusDispatchedPriorTurn, file: '/tmp/a.tsx' }).code, 2);
  });

  await t.test('a quoted implementer string in tool output is not a dispatch', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.quoted, file: '/tmp/a.tsx' }).code, 2);
  });

  await t.test('opus session writes source when the last typed prompt carries [tier-override:]', () => {
    const write = (name, entries) => {
      const p = path.join(tmpDir, `${name}.jsonl`);
      fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
      return run({ sessionId: newSession(), transcriptPath: p, file: '/tmp/a.tsx' }).code;
    };
    assert.equal(write('opusOverride', [OPUS_LINE, userLine('[tier-override: harness hook edit] go'), OPUS_LINE]), 0);
    assert.equal(write('opusOverrideBlocks', [OPUS_LINE, userLine([{ type: 'text', text: 'go\n[tier-override: harness hook edit]' }]), OPUS_LINE]), 0);
    assert.equal(write('opusOverrideStale', [OPUS_LINE, userLine('[tier-override: harness hook edit] go'), OPUS_LINE, userLine('now the test file'), OPUS_LINE]), 2);
    assert.equal(write('opusOverrideInToolResult', [OPUS_LINE, userLine([{ type: 'tool_result', content: '[tier-override: x]' }]), OPUS_LINE]), 2);
    assert.equal(write('opusOverrideInMeta', [OPUS_LINE, { type: 'user', isMeta: true, message: { content: '[tier-override: x]' } }, OPUS_LINE]), 2);
  });

  await t.test('silent below opus', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.sonnetTyped, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('opus session still writes docs and config directly', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: '/tmp/notes.md' }).code, 0);
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: '/tmp/settings.json' }).code, 0);
  });

  await t.test('opus session writes a session scratchpad probe directly', () => {
    const scratch = '/private/tmp/claude-501/-Users-p-repo/f503-session/scratchpad/probe.mjs';
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: scratch }).code, 0);
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: scratch.replace('/private', '') }).code, 0);
  });

  await t.test('a scratchpad folder outside the session temp dir still blocks', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: '/Users/p/repo/scratchpad/probe.mjs' }).code, 2);
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: '/tmp/claude-501/scratchpad/probe.mjs' }).code, 2);
  });

  await t.test('fable session stays blocked in the scratchpad', () => {
    assert.equal(run({ sessionId: newSession(), tier: 'fable', file: '/private/tmp/claude-501/-Users-p-repo/f503-session/scratchpad/probe.mjs' }).code, 2);
  });

  await t.test('a doc write is not gated — the next source write still blocks', () => {
    const sessionId = newSession();
    assert.equal(run({ sessionId, transcriptPath: transcripts.opusNoDispatch, file: '/tmp/notes.md' }).code, 0);
    assert.equal(run({ sessionId, transcriptPath: transcripts.opusNoDispatch, file: '/tmp/a.ts' }).code, 2);
  });

  await t.test('silent for a subagent', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.opusNoDispatch, file: '/tmp/a.tsx', agentId: 'agent-1' }).code, 0);
  });

  await t.test('fails open on an unreadable transcript', () => {
    const { code, stderr } = run({ sessionId: newSession(), transcriptPath: path.join(tmpDir, 'missing.jsonl'), file: '/tmp/a.tsx' });
    assert.equal(code, 0);
    assert.equal(stderr, '');
  });

  await t.test('fails open with no session id', () => {
    const { code, stderr } = run({ file: '/tmp/a.tsx' });
    assert.equal(code, 0);
    assert.equal(stderr, '');
  });

  await t.test('silent on empty stdin', () => {
    const res = spawnSync('bash', [HOOK_PATH], { input: '', encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
  });
});
