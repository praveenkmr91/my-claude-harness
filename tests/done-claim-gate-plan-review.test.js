'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOK_PATH, tmpDir, env, nextSeq } = require('./helpers/done-claim-gate');

test('done-claim gate: plan presented unreviewed', async (t) => {
  const PLAN = '/h/.claude/plans/x.md';
  const asks = {
    type: 'Should I start? Type `implement` and I\'ll hand both steps to the implementer.',
    typeRepo: 'So: type `implement` and I\'ll move the plan into the repo and build it.',
    say: 'If you say go, I\'ll hand it to the implementer.',
    waiting: 'The dry run is still running; I\'ll bring the plan back once it reports.',
  };
  const writePlan = (file = PLAN) => ({ type: 'tool_use', name: 'Write', input: { file_path: file } });
  const editPlan = (file = PLAN) => ({ type: 'tool_use', name: 'Edit', input: { file_path: file } });
  const review = (subagent_type, prompt, id) => ({ type: 'tool_use', name: 'Agent', ...(id && { id }), input: { subagent_type, prompt } });
  const toolResult = (id, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'denied' : 'ok', is_error: isError }] } });
  const advisor = { type: 'server_tool_use', name: 'advisor', input: {} };
  const assistant = (...content) => ({ type: 'assistant', message: { content } });
  const prompt = (text) => ({ type: 'user', message: { content: text } });
  const runPlan = (records, final, input = {}) => {
    const transcriptPath = path.join(tmpDir, `plan${nextSeq()}.jsonl`);
    fs.writeFileSync(transcriptPath, records.map((r) => JSON.stringify(r)).join('\n'));
    return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath, last_assistant_message: final, ...input }), encoding: 'utf8', env });
  };
  const turn = (blocks, final) => [prompt('plan it'), assistant(...blocks), assistant({ type: 'text', text: final })];
  const onModel = (model, records) => records.map((r) => (r.type === 'assistant' ? { ...r, message: { ...r.message, model } } : r));
  const interrupt = { type: 'assistant', message: { model: '<synthetic>', content: [] } };

  await t.test('blocks an implement ask on a plan nobody reviewed, and a reply that only waits stays quiet', () => {
    const records = (final) => turn([writePlan()], final);
    const fires = runPlan(records(asks.type), asks.type);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /PLAN PRESENTED UNREVIEWED/);
    assert.match(fires.stderr, /\(A\)/);
    assert.match(fires.stderr, /asks to implement x\.md/);
    assert.equal(runPlan(records(asks.waiting), asks.waiting).status, 0);
  });

  await t.test('an edit after the cold read and advisor stays covered: no review is owed for the edit alone', () => {
    const blocks = [writePlan(), review('cold-reader', PLAN), advisor, editPlan()];
    const quiet = runPlan(turn(blocks, asks.typeRepo), asks.typeRepo);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a dry-runner alone is no review: (A) fires, and a cold-reader on the same plan clears it', () => {
    const dryOnly = runPlan(turn([writePlan(), review('dry-runner', `Dry-run ${PLAN}`), advisor], asks.type), asks.type);
    assert.equal(dryOnly.status, 2, dryOnly.stderr);
    assert.match(dryOnly.stderr, /\(A\) no cold-reader ran on it/);
    const coldRead = runPlan(turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`), advisor], asks.type), asks.type);
    assert.equal(coldRead.status, 0, coldRead.stderr);
  });

  await t.test('blocks a reviewed plan with no advisor after its first review, quiet once the advisor ran', () => {
    const blocks = [writePlan(), review('cold-reader', `Cold-read ${PLAN}`)];
    const fires = runPlan(turn(blocks, asks.say), asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(B\)/);
    assert.doesNotMatch(fires.stderr, /\(A\)/);
    assert.equal(runPlan(turn([...blocks, advisor], asks.say), asks.say).status, 0);
  });

  await t.test('a review that names another plan does not cover this one, and a plugin-prefixed reviewer type counts', () => {
    const other = runPlan(turn([writePlan(), review('cold-reader', '/repo/docs/plans/other.md'), advisor], asks.type), asks.type);
    assert.equal(other.status, 2, other.stderr);
    assert.match(other.stderr, /\(A\)/);
    const prefixed = runPlan(turn([writePlan(), review('hera:cold-reader', `Cold-read ${PLAN}`), advisor], asks.type), asks.type);
    assert.equal(prefixed.status, 0, prefixed.stderr);
  });

  await t.test('a cold read of `build-ui.md` does not cover `ui.md`, one naming `ui.md` does', () => {
    const UI = '/h/.claude/plans/ui.md';
    const sibling = [prompt('plan A'), assistant(writePlan('/h/.claude/plans/build-ui.md'), review('cold-reader', '/h/.claude/plans/build-ui.md'), advisor), prompt('plan B')];
    const planB = assistant(writePlan(UI));
    const final = assistant({ type: 'text', text: asks.type });
    const fires = runPlan([...sibling, planB, final], asks.type);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(A\)/);
    const named = [prompt('plan A'), assistant(writePlan('/h/.claude/plans/other.md'), review('cold-reader', `Cold-read ui.md in ${UI}`), advisor), prompt('plan B')];
    const quiet = runPlan([...named, planB, final], asks.type);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a cold-reader dispatch that errored is no review, the same dispatch with a clean result is', () => {
    const tail = [advisor];
    const errored = runPlan([prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN, 'tu-c')), toolResult('tu-c', true), assistant(...tail), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(errored.status, 2, errored.stderr);
    assert.match(errored.stderr, /\(A\)/);
    const clean = runPlan([prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN, 'tu-c')), toolResult('tu-c', false), assistant(...tail), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(clean.status, 0, clean.stderr);
  });

  await t.test('a cold read of the plan under ~/.claude/plans still covers it once it moves to docs/plans', () => {
    const moved = [writePlan(), review('cold-reader', PLAN), advisor, editPlan('/repo/docs/plans/x.md')];
    const quiet = runPlan(turn(moved, asks.typeRepo), asks.typeRepo);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a `plan gate: skip` line before the ask does not clear (A)', () => {
    const reasoned = `plan gate: skip — trivial one-line plan\n${asks.type}`;
    const withReason = runPlan(turn([writePlan()], reasoned), reasoned);
    assert.equal(withReason.status, 2, withReason.stderr);
    assert.match(withReason.stderr, /\(A\)/);
    const bare = 'plan gate: skip\n' + asks.type;
    const withoutReason = runPlan(turn([writePlan()], bare), bare);
    assert.equal(withoutReason.status, 2, withoutReason.stderr);
    assert.match(withoutReason.stderr, /\(A\)/);
  });

  await t.test('no plan edit, or edits only to a research note, leave the implement ask alone', () => {
    assert.equal(runPlan(turn([], asks.type), asks.type).status, 0);
    assert.equal(runPlan(turn([writePlan('/h/.claude/plans/x.research.md')], asks.type), asks.type).status, 0);
  });

  await t.test('tracking spans turns: a review in turn 1 covers an ask in turn 2, and a plan edit in turn 2 stays covered', () => {
    const turn1 = [prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN), advisor), assistant({ type: 'text', text: 'Plan is ready.' })];
    const quiet = runPlan([...turn1, prompt('looks good'), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(quiet.status, 0, quiet.stderr);
    const edited = runPlan([...turn1, prompt('change step 2'), assistant(editPlan()), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(edited.status, 0, edited.stderr);
  });

  await t.test('an empty transcript, and a plan reply with no implement ask, pass', () => {
    const empty = runPlan([], asks.type);
    assert.equal(empty.status, 0, empty.stderr);
    const noAsk = runPlan(turn([writePlan()], 'The plan is written to x.md.'), 'The plan is written to x.md.');
    assert.equal(noAsk.status, 0, noAsk.stderr);
  });

  await t.test('a Fable thread\'s plan ask needs no advisor consult', () => {
    const records = [...onModel('claude-fable-5-2', turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`)], asks.say)), interrupt];
    const quiet = runPlan(records, asks.say);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a Fable thread\'s implement ask on a plan with no cold read is blocked', () => {
    const records = [...onModel('claude-fable-5-2', turn([writePlan()], asks.say)), interrupt];
    const fires = runPlan(records, asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(A\)/);
  });

  await t.test('a Fable thread\'s plan ask after an edit needs no new cold read', () => {
    const records = [...onModel('claude-fable-5-2', turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`), editPlan()], asks.say)), interrupt];
    const quiet = runPlan(records, asks.say);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('an Opus thread\'s plan ask still needs the advisor consult', () => {
    const fires = runPlan(onModel('claude-opus-5-5', turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`)], asks.say)), asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(B\)/);
  });

  await t.test('a reviewed plan passes with no `Pass: review` on any model; a missing cold read or advisor still blocks', () => {
    const blocks = [writePlan(), review('cold-reader', `Cold-read ${PLAN}`), advisor];
    const quiet = runPlan(turn(blocks, asks.type), asks.type);
    assert.equal(quiet.status, 0, quiet.stderr);
    const stale = runPlan(turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`), advisor, editPlan(), review('cold-reader', `Cold-read ${PLAN}`)], asks.type), asks.type);
    assert.equal(stale.status, 0, stale.stderr);
    const noColdRead = runPlan(turn([writePlan(), advisor], asks.type), asks.type);
    assert.equal(noColdRead.status, 2, noColdRead.stderr);
    assert.match(noColdRead.stderr, /\(A\)/);
    const noAdvisor = runPlan(onModel('claude-opus-5-5', turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`)], asks.type)), asks.type);
    assert.equal(noAdvisor.status, 2, noAdvisor.stderr);
    assert.match(noAdvisor.stderr, /\(B\)/);
  });

  await t.test('a reply that defers approval is not an implement ask', () => {
    const deferred = [
      'So: in `-99`, approve the `git commit --amend` that the safety check blocked. Then the builder commits and reports, and I detail chunk 2 with 134 translation keys for your `implement`.',
      'So: the plan isn\'t ready for you to approve yet. Once the check reports, I\'ll fix anything it finds, run the advisor review, and then present the plan for your "implement".',
      'So: everything is paused. Say "resume" and I\'ll apply those two fixes, then present the plan for your "implement".',
    ];
    for (const reply of deferred) {
      const quiet = runPlan(turn([writePlan()], reply), reply);
      assert.equal(quiet.status, 0, `${reply}\n${quiet.stderr}`);
    }
    const ask = 'So: type "implement" and the build starts.';
    assert.equal(runPlan(turn([writePlan()], ask), ask).status, 2);
  });
});
