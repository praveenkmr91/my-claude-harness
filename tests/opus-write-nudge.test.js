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
  await t.test('fires on the 3rd distinct file from an opus session', () => {
    const sessionId = newSession();
    assert.equal(writeN(2, { sessionId }).code, 0);
    const third = run({ sessionId, file: '/tmp/f2.ts' });
    assert.equal(third.code, 2);
    assert.match(third.stderr, /implementer/);
  });

  await t.test('same file three times does not fire — distinct files are the signal', () => {
    const sessionId = newSession();
    for (let i = 0; i < 3; i++) assert.equal(run({ sessionId, file: '/tmp/same.ts' }).code, 0);
  });

  await t.test('fires once per session', () => {
    const sessionId = newSession();
    assert.equal(writeN(3, { sessionId }).code, 2);
    assert.equal(run({ sessionId, file: '/tmp/f9.ts' }).code, 0);
  });

  await t.test('silent below opus — sonnet is already the intended writer', () => {
    assert.equal(writeN(4, { sessionId: newSession(), tier: 'sonnet' }).code, 0);
  });

  await t.test('fires from fable too — above opus is still the wrong tier to type edits', () => {
    assert.equal(writeN(3, { sessionId: newSession(), tier: 'fable' }).code, 2);
  });

  await t.test('silent for a subagent — a worker is already on its tier', () => {
    assert.equal(writeN(4, { sessionId: newSession(), agentId: 'agent-1' }).code, 0);
  });

  await t.test('fails open on an unreadable transcript', () => {
    assert.equal(writeN(4, { sessionId: newSession(), transcriptPath: '/nonexistent' }).code, 0);
  });

  await t.test('fails open with no session id', () => {
    assert.equal(run({ file: '/tmp/f.ts' }).code, 0);
  });
});
