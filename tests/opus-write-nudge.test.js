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

const OPUS_LINE = { type: 'assistant', message: { model: 'claude-opus-5' } };
const planAskLine = { type: 'user', message: { content: '\n\n<pasted_content id="1">\nImplement Chunk 2 of docs/plans/dplk-173-employer-withdrawal.md (DPLK-173).\n</pasted_content id="1">' } };
const userLine = (content) => ({ type: 'user', message: { content } });
for (const [name, entries] of Object.entries({
  planAsk: [planAskLine, OPUS_LINE],
  planAskBlocks: [userLine([{ type: 'text', text: 'Please implement step 3 of ~/.claude/plans/foo-bar.md' }]), OPUS_LINE],
  planNoVerb: [userLine('review docs/plans/x.md and tell me what you think'), OPUS_LINE],
  planVerbNoPath: [userLine('implement the dark mode toggle'), OPUS_LINE],
  planInToolResult: [userLine([{ type: 'tool_result', content: 'Implement Chunk 2 of docs/plans/x.md' }]), OPUS_LINE],
  planInMeta: [{ type: 'user', isMeta: true, message: { content: 'Implement Chunk 2 of docs/plans/x.md' } }, OPUS_LINE],
  planInCompactSummary: [{ type: 'user', isCompactSummary: true, message: { content: 'Chunk 1 is built only after an explicit "implement" of ~/.claude/plans/x.md' } }, OPUS_LINE],
  planNounImplementer: [userLine('what did the implementer change? see docs/plans/x.md'), OPUS_LINE],
  planNounImplementation: [userLine('review the implementation notes in docs/plans/x.md'), OPUS_LINE],
  planExecute: [userLine('Execute step 2 of docs/plans/x.md'), OPUS_LINE],
  planInTaskNotification: [userLine('<task-notification>\nImplement Chunk 2 of docs/plans/x.md</task-notification>'), OPUS_LINE],
  planInBashStdout: [userLine('<bash-stdout>Implement Chunk 2 of docs/plans/x.md</bash-stdout>'), OPUS_LINE],
  planDispatched: [planAskLine, { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'implementer' } }] } }, OPUS_LINE],
  planSonnet: [planAskLine, { type: 'assistant', message: { model: 'claude-sonnet-5' } }],
  planSkipGeneric: [planAskLine, { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'implementer: skip — step 1 is small and already in context.' }] } }],
  planSkipOpenCall: [planAskLine, { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'implementer: skip — open call: how a failed upload is tracked' }] } }],
  planSkipPriorTurn: [planAskLine, { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'implementer: skip — open call: how a failed upload is tracked' }] } }, userLine('now do step 2'), OPUS_LINE],
})) {
  transcripts[name] = path.join(tmpDir, `${name}.jsonl`);
  fs.writeFileSync(transcripts[name], entries.map((e) => JSON.stringify(e)).join('\n'));
}

let seq = 0;
const RUN = crypto.randomBytes(4).toString('hex');
const newSession = () => `nudge-test-${process.pid}-${RUN}-${seq++}`;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const f of fs.readdirSync('/tmp')) {
    if (f.startsWith(`claude-opus-write-nudge-nudge-test-${process.pid}`) ||
        f.startsWith(`claude-opus-write-files-nudge-test-${process.pid}`)) {
      fs.rmSync(path.join('/tmp', f), { force: true });
    }
  }
});

function run({ file, tier = 'opus', sessionId, agentId, transcriptPath, mode }) {
  const payload = {
    session_id: sessionId,
    agent_id: agentId,
    transcript_path: transcriptPath === undefined ? transcripts[tier] : transcriptPath,
    tool_input: { file_path: file },
  };
  const res = spawnSync('bash', [HOOK_PATH, ...(mode ? [mode] : [])], { input: JSON.stringify(payload), encoding: 'utf8' });
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

test('opus write nudge — pre arm', async (t) => {
  const pre = (opts) => run({ mode: 'pre', ...opts });

  await t.test('fable session blocks every source write, no plan ask needed', () => {
    const { code, stderr } = pre({ sessionId: newSession(), tier: 'fable', file: '/tmp/a.tsx' });
    assert.equal(code, 2);
    assert.match(stderr, /Fable never writes code/);
  });

  await t.test('fable session stays blocked after implementer was dispatched', () => {
    const fableDispatched = path.join(tmpDir, 'fable-dispatched.jsonl');
    fs.writeFileSync(fableDispatched, [
      { type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'implementer' } }] } },
      { type: 'assistant', message: { model: 'claude-fable-5-1' } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    assert.equal(pre({ sessionId: newSession(), transcriptPath: fableDispatched, file: '/tmp/a.tsx' }).code, 2);
  });

  await t.test('fable session still writes docs and config directly', () => {
    assert.equal(pre({ sessionId: newSession(), tier: 'fable', file: '/tmp/notes.md' }).code, 0);
    assert.equal(pre({ sessionId: newSession(), tier: 'fable', file: '/tmp/settings.json' }).code, 0);
  });

  await t.test('opus session without a plan ask is not blocked', () => {
    assert.equal(pre({ sessionId: newSession(), tier: 'opus', file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('blocks the first source write when a typed prompt asks to implement a plan', () => {
    const { code, stderr } = pre({ sessionId: newSession(), transcriptPath: transcripts.planAsk, file: '/tmp/a.tsx' });
    assert.equal(code, 2);
    assert.match(stderr, /executes an approved plan \(docs\/plans\/dplk-173-employer-withdrawal\.md\)/);
    assert.match(stderr, /implementer: skip — open call:/);
  });

  await t.test('a plain retry stays blocked', () => {
    const sessionId = newSession();
    assert.equal(pre({ sessionId, transcriptPath: transcripts.planAsk, file: '/tmp/a.tsx' }).code, 2);
    assert.equal(pre({ sessionId, transcriptPath: transcripts.planAsk, file: '/tmp/b.tsx' }).code, 2);
  });

  await t.test('a skip with a generic reason stays blocked', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planSkipGeneric, file: '/tmp/a.tsx' }).code, 2);
  });

  await t.test('a skip naming an open call passes', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planSkipOpenCall, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('a skip from an earlier turn does not carry over', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planSkipPriorTurn, file: '/tmp/a.tsx' }).code, 2);
  });

  await t.test('reads the plan path from text blocks', () => {
    const { code, stderr } = pre({ sessionId: newSession(), transcriptPath: transcripts.planAskBlocks, file: '/tmp/a.tsx' });
    assert.equal(code, 2);
    assert.ok(stderr.includes('~/.claude/plans/foo-bar.md'), stderr);
  });

  await t.test('a plan path without an implement or execute verb is silent', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planNoVerb, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('a verb without a plan path is silent', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planVerbNoPath, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('a plan ask quoted in tool output is not a typed prompt', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planInToolResult, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('a plan ask in an isMeta record is not a typed prompt', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planInMeta, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('a plan ask quoted in a compaction summary is not a typed prompt', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planInCompactSummary, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('implementer or implementation as a noun is not the verb', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planNounImplementer, file: '/tmp/a.tsx' }).code, 0);
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planNounImplementation, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('execute alone is the verb', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planExecute, file: '/tmp/a.tsx' }).code, 2);
  });

  await t.test('a plan ask inside a harness wrapper record is not a typed prompt', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planInTaskNotification, file: '/tmp/a.tsx' }).code, 0);
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planInBashStdout, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('silent once implementer was dispatched', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planDispatched, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('silent below opus', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planSonnet, file: '/tmp/a.tsx' }).code, 0);
  });

  await t.test('a doc write is not gated — the next source write still blocks', () => {
    const sessionId = newSession();
    assert.equal(pre({ sessionId, transcriptPath: transcripts.planAsk, file: '/tmp/plan.md' }).code, 0);
    assert.equal(pre({ sessionId, transcriptPath: transcripts.planAsk, file: '/tmp/a.ts' }).code, 2);
  });

  await t.test('silent for a subagent', () => {
    assert.equal(pre({ sessionId: newSession(), transcriptPath: transcripts.planAsk, file: '/tmp/a.tsx', agentId: 'agent-1' }).code, 0);
  });

  await t.test('does not run in post mode', () => {
    assert.equal(run({ sessionId: newSession(), transcriptPath: transcripts.planAsk, file: '/tmp/a.tsx' }).code, 0);
  });
});
