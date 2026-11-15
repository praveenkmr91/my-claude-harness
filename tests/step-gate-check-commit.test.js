'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bash,
  bashResult,
  dispatch,
  toolResult,
  handBackAttachment,
  DRY_RUN,
  LAUNCHED,
  STEP_DONE,
  run,
  assertQuiet,
} = require('./helpers/step-gate');

test('step gate: check commit', async (t) => {
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

  await t.test('an errored checker is not the check', () => {
    const checker = dispatch('checker', 'Run pnpm lint.', 'tu-check');
    const commit = bash('git commit -m "step 1"');
    const denied = toolResult('PreToolUse:Agent hook error: checker runs on haiku', true, 'tu-check');
    const { code, stderr } = run([...STEP_DONE, checker, denied, commit]);
    assert.equal(code, 2);
    assert.match(stderr, /handed back with no check from/);
    const launched = toolResult('Async agent launched successfully. agentId: c1', false, 'tu-check');
    assertQuiet(run([...STEP_DONE, checker, launched, commit]));
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
});
