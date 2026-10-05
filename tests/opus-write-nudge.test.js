'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
transcripts.dispatched = path.join(tmpDir, 'dispatched.jsonl');
fs.writeFileSync(transcripts.dispatched, [
  { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'implementer' } }] } },
  { type: 'assistant', message: { model: 'claude-opus-5' } },
].map((e) => JSON.stringify(e)).join('\n'));
transcripts.quoted = path.join(tmpDir, 'quoted.jsonl');
fs.writeFileSync(transcripts.quoted, [
  { type: 'user', message: { content: [{ type: 'tool_result', content: '"subagent_type":"implementer"' }] } },
  { type: 'assistant', message: { model: 'claude-opus-5' } },
].map((e) => JSON.stringify(e)).join('\n'));

let seq = 0;
const newSession = () => `nudge-test-${process.pid}-${seq++}`;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(`claude-opus-write-nudge-nudge-test-${process.pid}`) ||
        f.startsWith(`claude-opus-write-files-nudge-test-${process.pid}`)) {
      fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
  }
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

function writeN(n, opts) {
  let last;
  for (let i = 0; i < n; i++) last = run({ ...opts, file: `/tmp/f${i}.ts` });
  return last;
}

test('opus write nudge', async (t) => {
  await t.test('fires on the 6th distinct file from an opus session', () => {
    const sessionId = newSession();
    assert.equal(writeN(5, { sessionId }).code, 0);
    const sixth = run({ sessionId, file: '/tmp/f5.ts' });
    assert.equal(sixth.code, 2);
    assert.match(sixth.stderr, /implementer: skip — <reason>/);
  });

  await t.test('same file six times does not fire — distinct files are the signal', () => {
    const sessionId = newSession();
    for (let i = 0; i < 6; i++) assert.equal(run({ sessionId, file: '/tmp/same.ts' }).code, 0);
  });

  await t.test('non-source writes are not counted — six .md files stay silent, then six .ts files fire', () => {
    const sessionId = newSession();
    for (let i = 0; i < 6; i++) assert.equal(run({ sessionId, file: `/tmp/doc${i}.md` }).code, 0);
    assert.equal(writeN(5, { sessionId }).code, 0);
    assert.equal(run({ sessionId, file: '/tmp/f5.ts' }).code, 2);
  });

  await t.test('silent between the 6th and 15th file', () => {
    const sessionId = newSession();
    assert.equal(writeN(6, { sessionId }).code, 2);
    assert.equal(run({ sessionId, file: '/tmp/f9.ts' }).code, 0);
    assert.equal(run({ sessionId, file: '/tmp/f5.ts' }).code, 0);
  });

  await t.test('fires again on the 15th file when implementer was never dispatched', () => {
    const sessionId = newSession();
    assert.equal(writeN(14, { sessionId }).code, 0);
    const fifteenth = run({ sessionId, file: '/tmp/f14.ts' });
    assert.equal(fifteenth.code, 2);
    assert.match(fifteenth.stderr, /15 files itself with no `implementer` dispatch/);
    assert.equal(run({ sessionId, file: '/tmp/f20.ts' }).code, 0);
  });

  await t.test('silent on the 15th file once implementer was dispatched', () => {
    assert.equal(writeN(15, { sessionId: newSession(), transcriptPath: transcripts.dispatched }).code, 0);
  });

  await t.test('a quoted implementer string in tool output is not a dispatch', () => {
    assert.equal(writeN(15, { sessionId: newSession(), transcriptPath: transcripts.quoted }).code, 2);
  });

  await t.test('silent below opus — sonnet is already the intended writer', () => {
    assert.equal(writeN(7, { sessionId: newSession(), tier: 'sonnet' }).code, 0);
  });

  await t.test('fires from fable too — above opus is still the wrong tier to type edits', () => {
    assert.equal(writeN(6, { sessionId: newSession(), tier: 'fable' }).code, 2);
  });

  await t.test('silent for a subagent — a worker is already on its tier', () => {
    assert.equal(writeN(7, { sessionId: newSession(), agentId: 'agent-1' }).code, 0);
  });

  await t.test('fails open on an unreadable transcript', () => {
    assert.equal(writeN(7, { sessionId: newSession(), transcriptPath: '/nonexistent' }).code, 0);
  });

  await t.test('fails open with no session id', () => {
    assert.equal(run({ file: '/tmp/f.ts' }).code, 0);
  });
});
