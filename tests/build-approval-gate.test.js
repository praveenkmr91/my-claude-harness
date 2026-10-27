'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'build-approval-gate.sh');
const PLAN = '/Users/me/.claude/plans/build-approval-gate.md';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-approval-gate-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const user = (content) => ({ type: 'user', message: { content } });
const planEdit = (tool = 'Edit', file = PLAN) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'tu', name: tool, input: { file_path: file } }] },
});
const reply = { type: 'assistant', message: { content: [{ type: 'text', text: 'Open items below.' }] } };

let seq = 0;
function transcript(entries) {
  const file = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}

function run(toolInput, transcriptPath, extra = {}) {
  const payload = { transcript_path: transcriptPath, tool_input: toolInput, ...extra };
  const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr };
}

const write = (file, transcriptPath, extra) => run({ file_path: file }, transcriptPath, extra);
const dispatch = (type, transcriptPath, extra) => run({ subagent_type: type }, transcriptPath, extra);

test('build approval gate', async (t) => {
  const unapproved = transcript([planEdit(), reply, user('1. yes 2. yes'), reply]);

  await t.test('blocks a source write after a plan edit with no approval word', () => {
    const res = write('/repo/src/a.tsx', unapproved);
    assert.equal(res.code, 2);
    assert.ok(res.stderr.includes(PLAN), res.stderr);
    assert.match(res.stderr, /no typed implement \/ build \/ start/);
  });

  await t.test('blocks an implementer dispatch the same way', () => {
    assert.equal(dispatch('implementer', unapproved).code, 2);
  });

  await t.test('gates csv and package.json writes too', () => {
    assert.equal(write('/repo/EmployeePortal.csv', unapproved).code, 2);
    assert.equal(write('/repo/package.json', unapproved).code, 2);
  });

  await t.test('a plain Write of the plan counts as the plan edit', () => {
    const viaWrite = transcript([planEdit('Write'), reply]);
    assert.equal(write('/repo/src/a.tsx', viaWrite).code, 2);
  });

  await t.test('passes once a later typed prompt says implement', () => {
    const approved = transcript([planEdit(), reply, user('1. yes 2. yes'), reply, user('Implement it'), reply]);
    assert.equal(write('/repo/src/a.tsx', approved).code, 0);
    assert.equal(dispatch('implementer', approved).code, 0);
  });

  await t.test('passes on a typed build or start, as a word, in text blocks', () => {
    const build = transcript([planEdit(), user('build the hook')]);
    const start = transcript([planEdit(), user([{ type: 'text', text: 'ok, Start now' }])]);
    assert.equal(write('/repo/src/a.tsx', build).code, 0);
    assert.equal(write('/repo/src/a.tsx', start).code, 0);
  });

  await t.test('a word that only contains the approval word does not count', () => {
    const near = transcript([planEdit(), user('rebuild or restart later, the implementation notes first')]);
    assert.equal(write('/repo/src/a.tsx', near).code, 2);
  });

  await t.test('a negated or questioning prompt does not count', () => {
    for (const text of ['i didnt say go ahead to build', "I didn't say implement", "don't start yet", 'never build it', 'why not implement this', 'not now, build later']) {
      assert.equal(write('/repo/src/a.tsx', transcript([planEdit(), user(text)])).code, 2, text);
    }
  });

  await t.test('a multi-line prompt approves when any one line approves on its own', () => {
    const multi = transcript([planEdit(), reply, user('implement it, do not skip tests\nimplement the documents step')]);
    assert.equal(write('/repo/src/a.tsx', multi).code, 0);
    assert.equal(dispatch('implementer', multi).code, 0);
  });

  // Real prompts from transcripts: each approving one is paired with a near-twin that must stay blocked.
  await t.test('a clause that opens with the word approves, whatever other clauses say', () => {
    for (const text of [
      'implement. dont complicate or overnegineer. keep it simple',
      'dont wait for me, proceed to build and commit',
      'implement it, do not skip tests',
      'yes to both, implement chunk 1',
      'review plan and implement',
      'approved. start impl. follow subagent tier rules',
      'yes start 134',
      'Build it! Never mind the docs',
    ]) {
      assert.equal(write('/repo/src/a.tsx', transcript([planEdit(), reply, user(text)])).code, 0, text);
    }
  });

  await t.test('a deferral, question or mere mention does not approve', () => {
    for (const text of [
      'approved, move it. dont implement yet',
      'i only approved plan. doesnt mean u can start implementation',
      'new session will implement this plan. prepare and give me prompt',
      'are u proceeding to implement or making a plan first?',
      'lets implement all your plans first. prepare for implementation. ask for my approval',
      'build it later',
      "don't implement a.tsx yet",
      'start app',
      'thats not same app stupid. start this app server',
      'final submit is not deployed yet. only start is deployed',
      'why u never check shadcn baseui? after all our components are build/based on them',
      'why did you implement\nthat was wrong',
    ]) {
      assert.equal(write('/repo/src/a.tsx', transcript([planEdit(), reply, user(text)])).code, 2, text);
    }
  });

  await t.test('an approval word inside a tool result or harness record is not a typed prompt', () => {
    const quoted = transcript([
      planEdit(),
      user([{ type: 'tool_result', content: 'implement' }]),
      { type: 'user', isMeta: true, message: { content: 'implement' } },
      { type: 'user', isCompactSummary: true, message: { content: 'implement' } },
      user('<task-notification>implement</task-notification>'),
    ]);
    assert.equal(write('/repo/src/a.tsx', quoted).code, 2);
  });

  // Typed handoffs from a real receiving-session transcript: a named or peer session approves, a pointless or relayed one stays blocked.
  await t.test('a typed handoff to a named or peer session approves', () => {
    for (const text of [
      "follow session-A's instructions",
      'take instructions from session-A',
      'yes, follow session-A’s instructions',
      'take instructions from project-platformid-tram-operationportal-2b',
      "Follow session 63's instructions",
      "Follow session-A's instructions.",
      'follow other session instrcutions',
      'take instructions from peer session',
      "follow the other session's instructions",
    ]) {
      const handoff = transcript([planEdit(), reply, user(text)]);
      assert.equal(write('/repo/src/a.tsx', handoff).code, 0, text);
      assert.equal(dispatch('implementer', handoff).code, 0, text);
    }
  });

  await t.test('a handoff that points at no session, a negated or questioned one, or a mere mention of a session stays blocked', () => {
    for (const text of [
      'do what they say',
      'follow the plan',
      'follow session instructions',
      'the other session will implement this',
      'why do u need my input ? i just told u to take instructions from peer session',
      "should I take instructions from the peer session?",
      'follow DPLK-203 instructions',
      'follow git-flow',
      'project-platformid-tram-operationportal-2b will be the implementer',
      "don't follow session-A's instructions yet",
      "should I follow session-A's instructions?",
      'follow-up with session-A on instructions',
    ]) {
      assert.equal(write('/repo/src/a.tsx', transcript([planEdit(), reply, user(text)])).code, 2, text);
    }
  });

  await t.test('a handoff relayed from another session is not a typed prompt', () => {
    const relayed = 'Another Claude session sent a message:\n<agent-message from="a00f64ec4797dfd34">\nfollow session-A\'s instructions\n</agent-message>';
    const crossSession = transcript([
      planEdit(),
      reply,
      { type: 'user', isMeta: true, message: { content: relayed } },
      user(relayed),
      user('<agent-message from="a00f64ec4797dfd34">implement</agent-message>'),
    ]);
    assert.equal(write('/repo/src/a.tsx', crossSession).code, 2);
    assert.equal(dispatch('implementer', crossSession).code, 2);
  });

  await t.test('a prompt typed before the plan edit does not approve it', () => {
    assert.equal(write('/repo/src/a.tsx', transcript([user('implement the plan'), planEdit(), reply])).code, 2);
  });

  await t.test('a later edit to an already approved plan stays approved', () => {
    const revised = transcript([planEdit(), user('implement'), reply, planEdit(), reply, planEdit('Write'), reply]);
    assert.equal(write('/repo/src/a.tsx', revised).code, 0);
    assert.equal(dispatch('implementer', revised).code, 0);
  });

  await t.test('an edit to a different plan after an approval re-arms the gate', () => {
    const other = '/repo/docs/plans/other-feature.md';
    const rearmed = transcript([planEdit(), user('implement'), reply, planEdit('Edit', other), reply]);
    const res = write('/repo/src/a.tsx', rearmed);
    assert.equal(res.code, 2);
    assert.ok(res.stderr.includes(other), res.stderr);
    assert.equal(dispatch('implementer', rearmed).code, 2);
  });

  await t.test('returning to an approved plan after another plan was approved stays approved', () => {
    const other = '/repo/docs/plans/other-feature.md';
    const back = transcript([planEdit(), user('implement'), planEdit('Edit', other), user('build it'), planEdit(), reply]);
    assert.equal(write('/repo/src/a.tsx', back).code, 0);
  });

  await t.test('an approved plan moved into the repo stays approved', () => {
    const moved = transcript([planEdit(), user('build'), reply, planEdit('Edit', '/repo/docs/plans/build-approval-gate.md'), reply]);
    assert.equal(write('/repo/src/a.tsx', moved).code, 0);
    assert.equal(dispatch('implementer', moved).code, 0);
  });

  await t.test('a moved plan with a different name stays gated', () => {
    const renamed = transcript([planEdit(), user('build'), reply, planEdit('Edit', '/repo/docs/plans/other-feature.md'), reply]);
    assert.equal(write('/repo/src/a.tsx', renamed).code, 2);
  });

  await t.test('hook and test files are never gated, other harness scripts are', () => {
    assert.equal(write('/Users/me/.claude/hooks/build-approval-gate.sh', unapproved).code, 0);
    assert.equal(write('/Users/me/.claude/tests/build-approval-gate.test.js', unapproved).code, 0);
    assert.equal(write('/Users/me/.claude/automation/weekly-audit.sh', unapproved).code, 2);
  });

  await t.test('the session scratchpad is never gated, a repo scratchpad folder is', () => {
    const scratch = '/private/tmp/claude-501/-Users-p-repo/f503-session/scratchpad/probe.mjs';
    assert.equal(write(scratch, unapproved).code, 0);
    assert.equal(write(scratch.replace('/private', ''), unapproved).code, 0);
    assert.equal(write('/Users/p/repo/scratchpad/probe.mjs', unapproved).code, 2);
    assert.equal(write('/tmp/claude-501/scratchpad/probe.mjs', unapproved).code, 2);
  });

  await t.test('a plan research file is not a plan edit', () => {
    const research = transcript([planEdit('Write', '/Users/me/.claude/plans/build-approval-gate.research.md'), reply]);
    assert.equal(write('/repo/src/a.tsx', research).code, 0);
  });

  await t.test('a markdown write under plans/ passes, as does any non-source file', () => {
    assert.equal(write(PLAN, unapproved).code, 0);
    assert.equal(write('/repo/README.md', unapproved).code, 0);
    assert.equal(write('/repo/tsconfig.json', unapproved).code, 0);
  });

  await t.test('a dispatch of any other agent passes', () => {
    assert.equal(dispatch('Explore', unapproved).code, 0);
    assert.equal(dispatch('', unapproved).code, 0);
  });

  await t.test('fails open with no plan edit in the transcript', () => {
    const noPlan = transcript([user('1. yes 2. yes'), reply]);
    assert.equal(write('/repo/src/a.tsx', noPlan).code, 0);
    assert.equal(dispatch('implementer', noPlan).code, 0);
  });

  await t.test('fails open for a subagent', () => {
    assert.equal(write('/repo/src/a.tsx', unapproved, { agent_id: 'agent-1' }).code, 0);
    assert.equal(dispatch('implementer', unapproved, { agent_id: 'agent-1' }).code, 0);
  });

  await t.test('fails open on a missing or empty transcript', () => {
    assert.equal(write('/repo/src/a.tsx', '/nonexistent').code, 0);
    assert.equal(write('/repo/src/a.tsx', transcript([])).code, 0);
    assert.equal(write('/repo/src/a.tsx', undefined).code, 0);
  });

  await t.test('fails open on empty input', () => {
    const res = spawnSync('bash', [HOOK_PATH], { input: '', encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(spawnSync('bash', [HOOK_PATH], { input: '{}', encoding: 'utf8' }).status, 0);
  });
});
