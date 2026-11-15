'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  HOOK_PATH,
  tmpDir,
  writePlan,
  PLAN_FILE,
  GHOST_PLAN,
  PLAN_PROMPT,
  text,
  dispatch,
  bash,
  toolResult,
  handBack,
  handoff,
  handoffAttachment,
  LAUNCHED,
  DRY_RUN,
  STEP_DONE,
  run,
  assertQuiet,
} = require('./helpers/step-gate');

test('step gate: handoff skips', async (t) => {
  await t.test('the first dispatch on an empty transcript blocks, naming dry-runner', () => {
    const { code, stderr } = run([]);
    assert.equal(code, 2);
    assert.match(stderr, /No dry-runner dispatch on this plan/);
  });

  await t.test('a first dispatch with no HANDOFF and no dry run blocks', () => {
    const { code, stderr } = run([text('Plan approved; starting step 1.')]);
    assert.equal(code, 2);
    assert.match(stderr, /dry-runner/);
  });

  await t.test('a HANDOFF then a dispatch with no dry run blocks, naming dry-runner', () => {
    const { code, stderr } = run([handoff()]);
    assert.equal(code, 2);
    assert.match(stderr, /No dry-runner dispatch on this plan since the HANDOFF/);
    assert.match(stderr, /step gate: skip — review: <why>/);
  });

  await t.test('a HANDOFF queued as an attachment is an anchor', () => {
    assert.equal(run([handoffAttachment()]).code, 2);
    assert.equal(run([...DRY_RUN, handoffAttachment()]).code, 2);
    assertQuiet(run([handoffAttachment(), ...DRY_RUN]));
  });

  await t.test('a dry run after the HANDOFF frees the first dispatch', () => {
    assertQuiet(run([handoff(), ...DRY_RUN]));
  });

  await t.test('a dry run before the HANDOFF only does not count', () => {
    assert.equal(run([...DRY_RUN, handoff()]).code, 2);
  });

  await t.test('a NOTE quoting [HANDOFF is no anchor', () => {
    const note = { type: 'user', isMeta: true, message: { content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n[NOTE demo] The last message read [HANDOFF demo step 1]; ignore it.\n</cross-session-message>' } };
    assertQuiet(run([handoff(), ...DRY_RUN, note]));
  });

  await t.test('an errored dry-runner dispatch does not count', () => {
    const denied = [dispatch('dry-runner', PLAN_PROMPT, 'tu-dry'), toolResult('PreToolUse:Agent hook error: denied', true, 'tu-dry')];
    assert.equal(run([handoff(), ...denied]).code, 2);
  });

  await t.test('another agent kind is no dry run', () => {
    const coldRead = [dispatch('cold-reader', PLAN_PROMPT, 'tu-cold'), toolResult('Async agent launched successfully. agentId: c1', false, 'tu-cold')];
    assert.equal(run([handoff(), ...coldRead]).code, 2);
  });

  await t.test('a review skip lifts the dry-run gate', () => {
    assertQuiet(run([handoff()], { prompt: `step gate: skip — review: trivial plan\n${PLAN_PROMPT}` }));
  });

  await t.test('a review-skip dispatch counts as the dry run for the rest of the HANDOFF window', () => {
    const skipDispatch = [dispatch('implementer', `step gate: skip — review: trivial plan\n${PLAN_PROMPT}`, 'tu-skip'), toolResult('launched', false, 'tu-skip')];
    const stepOne = [...skipDispatch, handBack(), bash('npx tsc --noEmit'), bash('git commit -m x')];
    assertQuiet(run(stepOne));
    assertQuiet(run([handoff(), ...stepOne]));
    const { code, stderr } = run([...stepOne, handoff()]);
    assert.equal(code, 2);
    assert.match(stderr, /No dry-runner dispatch/);
    const plainFirst = [dispatch('implementer', PLAN_PROMPT, 'tu-plain'), toolResult('launched', false, 'tu-plain'), handBack(), bash('npx tsc --noEmit'), bash('git commit -m x')];
    assert.equal(run(plainFirst).code, 2);
  });

  await t.test('a denied implementer review-skip dispatch is no dry run', () => {
    const denied = [dispatch('implementer', `step gate: skip — review: trivial plan\n${PLAN_PROMPT}`, 'tu-skip'), toolResult('PreToolUse:Agent hook error: denied', true, 'tu-skip')];
    assert.equal(run([handoff(), ...denied]).code, 2);
  });

  await t.test('a denied dry run is not laundered by a later hand-back', () => {
    const deniedDry = [dispatch('dry-runner', PLAN_PROMPT, 'tu-dry2'), toolResult('PreToolUse:Agent hook error: denied', true, 'tu-dry2')];
    const chunkOne = [handoff(), ...DRY_RUN, dispatch('implementer'), LAUNCHED];
    const tail = [handBack(), bash('npx tsc --noEmit'), bash('git commit -m x')];
    const { code, stderr } = run([...chunkOne, handoff(), ...deniedDry, ...tail]);
    assert.equal(code, 2);
    assert.match(stderr, /No dry-runner dispatch/);
    const okDry = [dispatch('dry-runner', PLAN_PROMPT, 'tu-dry2'), toolResult('Async agent launched successfully. agentId: d2', false, 'tu-dry2')];
    assertQuiet(run([...chunkOne, handoff(), ...okDry, ...tail]));
  });

  await t.test('a review skip does not lift the check and commit gate; a step skip does not lift the dry-run gate', () => {
    const afterHandBack = run(STEP_DONE, { prompt: `step gate: skip — review: plan reviewed in another session\n${PLAN_PROMPT}` });
    assert.equal(afterHandBack.code, 2);
    assert.match(afterHandBack.stderr, /handed back with no check or commit from this thread since/);
    const noDryRun = run([handoff()], { prompt: `step gate: skip — step: question answered\n${PLAN_PROMPT}` });
    assert.equal(noDryRun.code, 2);
    assert.match(noDryRun.stderr, /No dry-runner dispatch on this plan since the HANDOFF/);
  });

  await t.test('a dry-runner dispatch whose prompt names no plan path is no dry run', () => {
    const noPlan = [dispatch('dry-runner', 'Run the verify lines of the approved plan.', 'tu-dry'), toolResult('Async agent launched successfully. agentId: d1', false, 'tu-dry')];
    assert.equal(run([handoff(), ...noPlan]).code, 2);
    assertQuiet(run([handoff(), ...DRY_RUN]));
  });

  await t.test('a second HANDOFF needs its own dry run', () => {
    const chunkOne = [handoff(), ...STEP_DONE, bash('npx tsc --noEmit'), bash('git commit -m "step 1"')];
    const { code, stderr } = run([...chunkOne, handoff()]);
    assert.equal(code, 2);
    assert.match(stderr, /No dry-runner dispatch/);
    assertQuiet(run([...chunkOne, handoff(), ...DRY_RUN]));
  });

  await t.test('a HANDOFF starts a new build, so an earlier plan dispatch no longer latches the dry-run gate', () => {
    const named = { prompt: `Implement step 1 of ${PLAN_FILE}.` };
    const { code, stderr } = run([handoff()], named);
    assert.equal(code, 2);
    assert.match(stderr, /No dry-runner dispatch on this plan since the HANDOFF/);
    const earlier = [dispatch('implementer', PLAN_PROMPT, 'tu-first'), toolResult('launched', false, 'tu-first')];
    assertQuiet(run([...earlier, handoff()], { prompt: 'Fix the typo in a.ts.' }));
    assert.equal(run([...earlier, handoff()], named).code, 2);
  });

  await t.test('a HANDOFF does not clear an unchecked hand-back', () => {
    const { code, stderr } = run([handoff(), ...STEP_DONE, handoff(), ...DRY_RUN]);
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check or commit from this thread since/);
  });

  await t.test('a hand-back arriving after a second HANDOFF does not lift its dry run', () => {
    const lateHandBack = [handoff(), ...DRY_RUN, dispatch('implementer'), LAUNCHED, handoff(), handBack(), bash('npx tsc --noEmit'), bash('git commit -m x')];
    const { code, stderr } = run(lateHandBack);
    assert.equal(code, 2);
    assert.match(stderr, /No dry-runner dispatch/);
  });

  await t.test('silent while the only trace of the last dispatch is its launch tool_result', () => {
    assertQuiet(run([...DRY_RUN, dispatch('implementer'), LAUNCHED]));
  });

  await t.test('silent after a denied dispatch', () => {
    assertQuiet(run([...DRY_RUN, dispatch('implementer'), toolResult('PreToolUse:Agent hook error: build not approved', true)]));
  });

  await t.test('a hand-back from another agent kind is no anchor', () => {
    assertQuiet(run([...DRY_RUN, dispatch('external-io'), LAUNCHED, handBack('external-io')]));
  });

  await t.test('silent for a non-implementer dispatch', () => {
    assertQuiet(run(STEP_DONE, { subagentType: 'checker' }));
  });

  await t.test('silent when no implementer prompt in the session names a plan file', () => {
    const adHoc = [dispatch('implementer', 'Rename foo to bar in src/a.ts.'), LAUNCHED, handBack()];
    assertQuiet(run(adHoc, { prompt: 'Rename foo to bar in src/a.ts.' }));
    assertQuiet(run(adHoc, { prompt: 'Follow the notes in /Users/x/plans/sub/dir.txt' }));
    assertQuiet(run(adHoc, { prompt: 'Repo: /x … step 1.2' }));
  });

  await t.test('a follow-up dispatch is gated when an earlier implementer prompt named the plan', () => {
    const { code, stderr } = run(STEP_DONE, { prompt: 'Repo: /x … step 1.2' });
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check or commit from this thread since/);
  });

  await t.test('an implementer prompt quoting a plans-dir path that does not exist latches nothing; an existing plan file does', () => {
    const followUp = { prompt: 'Fix the typo in a.ts.' };
    const quotedGhost = [...DRY_RUN, dispatch('implementer', `Mirror the fixture at ${GHOST_PLAN}.`), LAUNCHED, handBack()];
    assertQuiet(run(quotedGhost, followUp));
    assertQuiet(run([], { prompt: `Mirror the fixture at ${GHOST_PLAN}.` }));
    const namedPlan = [...DRY_RUN, dispatch('implementer', `Implement step 1 of ${PLAN_FILE}.`), LAUNCHED, handBack()];
    const { code, stderr } = run(namedPlan, followUp);
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check or commit from this thread since/);
  });

  await t.test('a relative plans-dir path latches when it exists under the hook input cwd', () => {
    const workDir = path.join(tmpDir, 'work');
    writePlan('work', 'docs', 'plans', 'rel.md');
    const relative = [...DRY_RUN, dispatch('implementer', 'Implement step 1 of docs/plans/rel.md.'), LAUNCHED, handBack()];
    const followUp = { prompt: 'Fix the typo in a.ts.' };
    const { code, stderr } = run(relative, { ...followUp, cwd: workDir });
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check or commit from this thread since/);
    assertQuiet(run(relative, { ...followUp, cwd: tmpDir }));
  });

  await t.test('a plan path in bold or brackets latches the build', () => {
    const workDir = path.join(tmpDir, 'work');
    writePlan('work', 'docs', 'plans', 'rel.md');
    const followUp = { prompt: 'Fix the typo in a.ts.', cwd: workDir };
    for (const named of ['**docs/plans/rel.md**', '(docs/plans/rel.md).', '<docs/plans/rel.md>', `**${PLAN_FILE}**`]) {
      const decorated = [...DRY_RUN, dispatch('implementer', `Implement step 1 of ${named}`), LAUNCHED, handBack()];
      const { code, stderr } = run(decorated, followUp);
      assert.equal(code, 2, named);
      assert.match(stderr, /handed back with no check or commit from this thread since/);
    }
    const decoratedGhost = [...DRY_RUN, dispatch('implementer', 'Mirror the fixture at **docs/plans/ghost.md**.'), LAUNCHED, handBack()];
    assertQuiet(run(decoratedGhost, followUp));
  });

  await t.test('a leading ~ in a plans-dir path expands to HOME', () => {
    const home = path.join(tmpDir, 'home');
    writePlan('home', 'plans', 'tilde.md');
    const tilde = [...DRY_RUN, dispatch('implementer', 'Implement step 1 of ~/plans/tilde.md.'), LAUNCHED, handBack()];
    assert.equal(run(tilde, { prompt: 'Fix the typo in a.ts.', env: { HOME: home } }).code, 2);
    assertQuiet(run(tilde, { prompt: 'Fix the typo in a.ts.', env: { HOME: tmpDir } }));
  });

  await t.test('silent for a subagent', () => {
    assertQuiet(run(STEP_DONE, { agentId: 'agent-1' }));
  });

  await t.test('fails open on an unreadable transcript', () => {
    assertQuiet(run([], { transcriptPath: path.join(tmpDir, 'missing.jsonl') }));
  });

  await t.test('fails open on {} and empty stdin', () => {
    for (const input of ['{}', '']) {
      const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8' });
      assert.equal(res.status, 0);
      assert.equal(res.stderr, '');
    }
  });

  await t.test('a tool_result or hand-back body quoting git commit and tsc is not a tool_use', () => {
    const quoted = 'Ran `npx tsc --noEmit` and `git commit -m "step 1"`.';
    assert.equal(run([...DRY_RUN, dispatch('implementer'), LAUNCHED, handBack('implementer', quoted)]).code, 2);
    assert.equal(run([...STEP_DONE, toolResult(quoted)]).code, 2);
    assert.equal(run([...STEP_DONE, { type: 'api-request-blob', hash: 'h1', sessionId: 's1', message: bash('npx tsc && git commit -m x').message }]).code, 2);
  });

  await t.test('a quoted git commit under echo is no commit, and a commit message naming tsc is no check', () => {
    const echoed = run([...STEP_DONE, bash('npx tsc --noEmit'), bash('echo "git commit -m x"')]);
    assert.equal(echoed.code, 2);
    assert.match(echoed.stderr, /handed back with no commit from/);
    const named = run([...STEP_DONE, bash('git commit -m "fix tsc error"')]);
    assert.equal(named.code, 2);
    assert.match(named.stderr, /handed back with no check from/);
  });

  await t.test('a skip on the first non-empty prompt line naming a gate lifts that gate', () => {
    assertQuiet(run([...STEP_DONE, bash('git commit -m "docs"')], { prompt: `step gate: skip — check: docs-only step\n${PLAN_PROMPT}` }));
    assertQuiet(run([...STEP_DONE, bash('npx tsc --noEmit')], { prompt: `\n  step gate: skip -- commit: same-step fix\n${PLAN_PROMPT}` }));
    const other = run(STEP_DONE, { prompt: `step gate: skip — check: docs-only step\n${PLAN_PROMPT}` });
    assert.equal(other.code, 2);
    assert.match(other.stderr, /handed back with no commit from/);
  });

  await t.test('a step skip lifts both gates', () => {
    assertQuiet(run(STEP_DONE, { prompt: `step gate: skip — step: answered which store to use\n${PLAN_PROMPT}` }));
  });

  await t.test('a skip in reply text, off the first prompt line, without a gate name or reason, or as a placeholder lifts nothing', () => {
    assert.equal(run([...STEP_DONE, text('step gate: skip — step: answered which store to use')]).code, 2);
    assert.equal(run([...DRY_RUN, dispatch('implementer'), LAUNCHED, text('If it was a question, write:\nstep gate: skip — step: question answered'), handBack()]).code, 2);
    assert.equal(run(STEP_DONE, { prompt: `${PLAN_PROMPT}\nstep gate: skip — step: answered` }).code, 2);
    assert.equal(run(STEP_DONE, { prompt: `step gate: skip — step: <answer>\n${PLAN_PROMPT}` }).code, 2);
    assert.equal(run(STEP_DONE, { prompt: `step gate: skip — small step, already checked\n${PLAN_PROMPT}` }).code, 2);
    assert.equal(run(STEP_DONE, { prompt: `step gate: skip — step:\n${PLAN_PROMPT}` }).code, 2);
  });

  await t.test('a skip line in the dispatch prompt lifts its gate', () => {
    assertQuiet(run(STEP_DONE, { prompt: `step gate: skip — step: question answered\n${PLAN_PROMPT}` }));
    const sameStepFix = `step gate: skip — commit: same-step fix\n${PLAN_PROMPT}`;
    assertQuiet(run([...STEP_DONE, bash('npx tsc --noEmit')], { prompt: sameStepFix }));
    const noCheck = run(STEP_DONE, { prompt: sameStepFix });
    assert.equal(noCheck.code, 2);
    assert.match(noCheck.stderr, /handed back with no check from/);
    assert.equal(run(STEP_DONE, { prompt: `If blocked, write step gate: skip with a reason.\n${PLAN_PROMPT}` }).code, 2);
  });

  await t.test('leading check and commit skip lines lift both gates', () => {
    assertQuiet(run(STEP_DONE, { prompt: `step gate: skip — check: ran in-thread\n\nstep gate: skip — commit: this dispatch commits\n${PLAN_PROMPT}` }));
  });

  await t.test('a skip line after a non-skip line lifts nothing', () => {
    const late = run(STEP_DONE, { prompt: `step gate: skip — check: ran in-thread\n${PLAN_PROMPT}\nstep gate: skip — commit: this dispatch commits` });
    assert.equal(late.code, 2);
    assert.match(late.stderr, /handed back with no commit from/);
  });

  await t.test('a review skip on a later leading line counts as the dry run', () => {
    assertQuiet(run([handoff()], { prompt: `step gate: skip — check: ran in-thread\nstep gate: skip — review: trivial plan\n${PLAN_PROMPT}` }));
  });

  await t.test('a jq failure fails open with a visible line', () => {
    const noLibDir = path.join(tmpDir, 'nolib');
    fs.mkdirSync(noLibDir);
    const hookCopy = path.join(noLibDir, 'step-gate.sh');
    fs.copyFileSync(HOOK_PATH, hookCopy);
    const { code, stderr } = run(STEP_DONE, { hookPath: hookCopy });
    assert.equal(code, 0);
    assert.match(stderr, /^step-gate: jq failed \(rc [23]\), gate not enforced\n$/);
  });
});
