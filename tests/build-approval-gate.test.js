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

  await t.test('a vetoed line does not approve without a clean approving line', () => {
    const single = transcript([planEdit(), reply, user('implement it, do not skip tests')]);
    const questioned = transcript([planEdit(), reply, user('why did you implement\nthat was wrong')]);
    assert.equal(write('/repo/src/a.tsx', single).code, 2);
    assert.equal(write('/repo/src/a.tsx', questioned).code, 2);
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

  await t.test('a prompt typed before the plan edit does not approve it', () => {
    assert.equal(write('/repo/src/a.tsx', transcript([user('implement the plan'), planEdit(), reply])).code, 2);
  });

  await t.test('a plan edit after the approval re-arms the gate', () => {
    const rearmed = transcript([planEdit(), user('implement'), reply, planEdit(), reply]);
    assert.equal(write('/repo/src/a.tsx', rearmed).code, 2);
    assert.equal(dispatch('implementer', rearmed).code, 2);
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
