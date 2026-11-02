'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'step-gate.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-gate-'));
const writePlan = (...segments) => {
  const file = path.join(tmpDir, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# plan\n');
  return file;
};
const PLAN_FILE = writePlan('plans', 'demo.md');
const GHOST_PLAN = path.join(tmpDir, 'plans', 'ghost.md');
const PLAN_PROMPT = `Implement step 1.2 only of the approved plan ${PLAN_FILE}.`;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const assistant = (content) => ({ type: 'assistant', message: { model: 'claude-opus-5', content } });
const toolUse = (name, input, id = `tu-${name}`) => assistant([{ type: 'tool_use', id, name, input }]);
const dispatch = (subagentType, prompt = PLAN_PROMPT, id) => toolUse('Agent', { subagent_type: subagentType, prompt }, id);
const bash = (command, id) => toolUse('Bash', { command }, id);
const text = (t) => assistant([{ type: 'text', text: t }]);
const toolResult = (content, isError, id = 'tu-Agent') => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }] },
});
const bashResult = (content, isError, id = 'tu-Bash') => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }] },
});
const handBack = (name = 'implementer', report = 'Step 1.1 done.') => ({
  type: 'user',
  isMeta: true,
  origin: { kind: 'peer', from: 'a1b2c3', senderTaskId: 'a1b2c3', name, body: `[Subagent hand-back] ${report}`, handback: true },
  message: { content: `Another Claude session sent a message:\n<agent-message from="a1b2c3">\n[Subagent hand-back] ${report}` },
});
const handBackAttachment = (name = 'implementer') => ({
  type: 'attachment',
  attachment: {
    type: 'queued_command',
    commandMode: 'prompt',
    prompt: '<agent-message from="a1b2c3">\n[Subagent hand-back] Step 1.1 done.',
    origin: { kind: 'peer', from: 'a1b2c3', senderTaskId: 'a1b2c3', name, body: '[Subagent hand-back] Step 1.1 done.', handback: true, handbackReportText: 'Step 1.1 done.' },
  },
});
const HANDOFF_ENVELOPE = `<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n[HANDOFF demo step 1] Rules: ~/.claude/peer-sessions.md\nPlan: ${PLAN_FILE}\n</cross-session-message>`;
const handoff = () => ({ type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${HANDOFF_ENVELOPE}` } });
const handoffAttachment = () => ({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, prompt: HANDOFF_ENVELOPE } });
const LAUNCHED = toolResult('Async agent launched successfully. agentId: a1b2c3');
const DRY_RUN = [dispatch('dry-runner', PLAN_PROMPT, 'tu-dry'), toolResult('Async agent launched successfully. agentId: d1', false, 'tu-dry')];
const STEP_DONE = [...DRY_RUN, dispatch('implementer'), LAUNCHED, handBack()];

let seq = 0;
function transcript(entries) {
  const p = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
  return p;
}

function run(entries, { subagentType = 'implementer', prompt = PLAN_PROMPT, agentId, transcriptPath, hookPath = HOOK_PATH, cwd, env } = {}) {
  const payload = {
    session_id: 'step-gate-test',
    agent_id: agentId,
    cwd,
    transcript_path: transcriptPath ?? transcript(entries),
    tool_input: { subagent_type: subagentType, prompt },
  };
  const res = spawnSync('bash', [hookPath], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: res.status, stderr: res.stderr };
}

function assertQuiet({ code, stderr }) {
  assert.equal(code, 0);
  assert.equal(stderr, '');
}

test('step gate', async (t) => {
  await t.test('a dispatch after a hand-back with neither gate blocks, naming both', () => {
    const { code, stderr } = run(STEP_DONE);
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check or commit from this thread since/);
    assert.match(stderr, /step gate: skip — <check\|commit>: <why>/);
  });

  await t.test('check and commit since the hand-back pass', () => {
    assertQuiet(run([...STEP_DONE, bash('npx tsc --noEmit'), bash('git commit --only a.ts -m "step 1"')]));
  });

  await t.test('check only blocks, naming the commit', () => {
    const { code, stderr } = run([...STEP_DONE, bash('pnpm run lint')]);
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no commit from/);
  });

  await t.test('commit only blocks, naming the check', () => {
    const { code, stderr } = run([...STEP_DONE, bash('git commit -m "step 1"')]);
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check from/);
  });

  await t.test('a checker dispatch counts as the check; another agent kind does not', () => {
    assertQuiet(run([...STEP_DONE, dispatch('checker'), bash('git commit -m "step 1"')]));
    assert.equal(run([...STEP_DONE, dispatch('Explore'), bash('git commit -m "step 1"')]).code, 2);
  });

  await t.test('git -C with a quoted path still counts as a commit', () => {
    assertQuiet(run([...STEP_DONE, bash('node --test tests/a.test.js'), bash('git -C "/p" commit -m "step 1"')]));
  });

  await t.test('a commit counts only at command position', () => {
    const counts = (command) => run([...STEP_DONE, bash('npx tsc --noEmit'), bash(command)]).code === 0;
    const pairs = [
      ['git commit -m x', 'grep -n update-ref committing.md'],
      ['git -c user.name=x commit -m x', 'git commit --dry-run'],
      ['cd r && git commit -m x', 'echo git commit'],
      ['git update-ref refs/heads/m $n $o', 'git commit --help'],
      ['time git commit -m x', 'git commit -m x --dry-run'],
    ];
    for (const [commit, notCommit] of pairs) {
      assert.equal(counts(commit), true, commit);
      assert.equal(counts(notCommit), false, notCommit);
    }
  });

  await t.test('an errored or denied commit is no commit', () => {
    const errored = run([...STEP_DONE, bash('npx tsc --noEmit', 'tu-tsc'), bash('git commit -m x'), bashResult('nothing to commit, working tree clean', true)]);
    assert.equal(errored.code, 2);
    assert.match(errored.stderr, /handed back with no commit from/);
    assertQuiet(run([...STEP_DONE, bash('npx tsc --noEmit'), bash('git commit -m x'), bashResult('[master abc] x')]));
    const denied = bashResult('PreToolUse:Bash hook error: commit blocked', true);
    assert.equal(run([...STEP_DONE, bash('npx tsc --noEmit'), bash('git commit -m x'), denied]).code, 2);
  });

  await t.test('an errored check is no check; a green rerun counts', () => {
    const red = bashResult('error TS2322', true, 'tu-tsc');
    const errored = run([...STEP_DONE, bash('npx tsc --noEmit', 'tu-tsc'), red, bash('git commit -m x')]);
    assert.equal(errored.code, 2);
    assert.match(errored.stderr, /handed back with no check from/);
    assertQuiet(run([...STEP_DONE, bash('npx tsc --noEmit', 'tu-tsc'), bashResult('', false, 'tu-tsc'), bash('git commit -m x')]));
    const green = bashResult('', false, 'tu-tsc2');
    assertQuiet(run([...STEP_DONE, bash('npx tsc --noEmit', 'tu-tsc'), red, bash('npx tsc --noEmit', 'tu-tsc2'), green, bash('git commit -m x')]));
  });

  await t.test('gates met before the last hand-back do not carry over', () => {
    assert.equal(run([...STEP_DONE, bash('npx tsc --noEmit'), bash('git commit -m "step 1"'), ...STEP_DONE]).code, 2);
    assertQuiet(run([...STEP_DONE, ...STEP_DONE, bash('npx tsc --noEmit'), bash('git commit -m "step 2"')]));
  });

  await t.test('a hand-back queued as an attachment is an anchor', () => {
    const { code, stderr } = run([...DRY_RUN, dispatch('implementer'), LAUNCHED, handBackAttachment('implementer')]);
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check or commit from this thread since/);
    assert.equal(run([...STEP_DONE, bash('npx tsc --noEmit'), bash('git commit -m "step 1"'), dispatch('implementer'), LAUNCHED, handBackAttachment()]).code, 2);
  });

  await t.test('an attachment hand-back from another agent kind is no anchor', () => {
    assertQuiet(run([...DRY_RUN, dispatch('checker'), LAUNCHED, handBackAttachment('checker')]));
  });

  await t.test('a check counts only at command position', () => {
    const counts = (command) => run([...STEP_DONE, bash(command), bash('git commit -m "step 1"')]).code === 0;
    const pairs = [
      ['eslint package.json', 'grep eslint package.json'],
      ['git log; tsc', 'git log --grep tsc'],
      ['npx oxlint .', 'echo npx oxlint .'],
      ['pnpm run check:types', 'pnpm run build'],
      ['cd x && npx tsc --noEmit', 'cd x && ls tsc'],
      ['node --test tests/x.test.js', 'node tests/x.test.js'],
      ['FOO=1 pnpm test', 'FOO=1 pnpm build'],
      ['cd x\nnpx tsc --noEmit', 'cd x\necho "npx tsc"'],
      ['pnpm --filter web lint', 'pnpm --filter web build'],
      ['npx jest', 'echo npx jest'],
      ['pnpm exec jest --ci', 'pnpm exec cat jest.config.js'],
      ['flutter analyze && flutter test', 'flutter pub get'],
      ['./gradlew ktlintCheck', './gradlew assembleDebug'],
      ['xcodebuild -scheme App test', 'xcodebuild -scheme App build'],
      ['swiftlint', 'brew install swiftlint'],
      ['npx ng lint', 'npx ng serve'],
      ['npx nx lint web', 'npx nx graph'],
      ['npx turbo run lint', 'npx turbo run build'],
      ['npx playwright test', 'npx playwright install'],
      ['yarn workspace web lint', 'yarn workspace web start'],
      ['npm t', 'npm i'],
      ['command tsc', 'command ls'],
      ['./gradlew :app:testDebugUnitTest', './gradlew :app:assembleDebug'],
      ['./gradlew connectedAndroidTest', './gradlew -p latest build'],
      ['npx biome check .', 'npx biome format .'],
      ['npx svelte-check', 'npx svelte-kit sync'],
      ['tsc --noEmit', 'tsc --version'],
    ];
    for (const [check, notCheck] of pairs) {
      assert.equal(counts(check), true, check);
      assert.equal(counts(notCheck), false, notCheck);
    }
  });

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
    assertQuiet(run([...DRY_RUN, dispatch('implementer'), toolResult('PreToolUse:Agent hook error: build not approved')]));
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
