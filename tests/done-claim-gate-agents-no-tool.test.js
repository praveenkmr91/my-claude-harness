'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOK_PATH, tmpDir, RAW_OUTPUT, runFull, runWithResults } = require('./helpers/done-claim-gate');
const {
  stamp, sourceLines, CLAIM, scratchRepo, writeOf, dispatchOf, checked, opts, blocked, quiet, ALL_NAMES, BIG_NAMES, allRuns, bigDispatches,
} = require('./helpers/done-claim-gate-agents');

test('done-claim gate: review agents on no-tool claims and claim wording', async (t) => {
  const noCodeTurn = (repo, ...tail) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, ...tail];
  const stopTurn = (repo, ...earlier) => [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), dispatchOf('code-reviewer', stamp(2)), ...earlier, { prompt: 'next', timestamp: stamp(3) }];

  await t.test('a no-tool turn that claims done or complete after Big writes is blocked for the Big members; a status line, a Step N claim and a word outside its claim set are quiet', () => {
    const repo = scratchRepo();
    const reply = (text, ...earlier) => runWithResults(text, stopTurn(repo, ...earlier), opts(repo));
    for (const text of ['Yes, it\'s done.', 'The work is complete.']) {
      blocked(reply(text), BIG_NAMES);
      quiet(reply(text, ...bigDispatches(stamp(2))));
    }
    for (const text of ['Not done yet.', 'Step 3 done.', 'The submission works.', 'The work isn\'t complete.', 'The work is not complete.']) quiet(reply(text));
  });

  await t.test('"Done" on a no-tool turn over 300 uncovered lines is blocked naming exactly the five members; runs after the write are quiet', () => {
    const repo = scratchRepo();
    const turn = (...runs) => runWithResults('Done.', [writeOf(repo, 'impl.ts', sourceLines(300), stamp(1)), ...runs, { prompt: 'next', timestamp: stamp(3) }], opts(repo));
    blocked(turn(), ALL_NAMES);
    quiet(turn(...allRuns(stamp(2))));
  });

  await t.test('a no-tool claim after 30 unreviewed lines is blocked for code-reviewer; quiet once it was dispatched after the write', () => {
    const repo = scratchRepo();
    blocked(runWithResults('Yes, it\'s done.', noCodeTurn(repo), opts(repo)), 'code-reviewer');
    const reviewed = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(2)), { prompt: 'next', timestamp: stamp(3) }];
    quiet(runWithResults('Yes, it\'s done.', reviewed, opts(repo)));
  });

  const failingClassifierHome = () => {
    const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
    fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'hooks', 'review-classify.py'), 'import sys\nprint("boom", file=sys.stderr)\nsys.exit(1)\n');
    return home;
  };
  const CLASSIFIER_WARNING = { systemMessage: 'review-classify failed: boom' };

  await t.test('a session with no code write and no agent skips the classifier on a claim; once it wrote a .ts file the classifier runs', () => {
    const home = failingClassifierHome();
    const repo = scratchRepo();
    const idle = runWithResults('Yes, it\'s done.', [], opts(repo, { home }));
    assert.deepEqual([idle.status, idle.stdout, idle.stderr], [0, '', '']);
    const wrote = runWithResults('Yes, it\'s done.', [writeOf(repo, 'impl.ts', sourceLines(1), stamp(1)), { prompt: 'next', timestamp: stamp(3) }], opts(repo, { home }));
    assert.equal(wrote.status, 0, wrote.stderr);
    assert.deepEqual(JSON.parse(wrote.stdout), CLASSIFIER_WARNING);
  });

  await t.test('an agent dispatch alone, with no main-thread write, starts the session work, so a later claim runs the classifier', () => {
    const repo = scratchRepo();
    const res = runWithResults('Yes, it\'s done.', [dispatchOf('Explore', stamp(1)), { prompt: 'next', timestamp: stamp(3) }], opts(repo, { home: failingClassifierHome() }));
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), CLASSIFIER_WARNING);
  });

  await t.test('a no-tool claim after Big writes blocks on the retry; a Stop in the window a delivered STOP-answering REPORT opened is exempt on the first run and the retry, and a typed prompt ends that', () => {
    const repo = scratchRepo();
    const stopEnvelope = '<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n[STOP demo] Stop after this step and report.\n</cross-session-message>';
    const answered = [
      { record: { type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${stopEnvelope}` } } },
      { sent: `[REPORT demo step 1] Stopped before step 2 started.\n${RAW_OUTPUT}`, output: 'Message sent to planner-1', timestamp: stamp(4) },
    ];
    const written = [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), dispatchOf('code-reviewer', stamp(2))];
    const typed = { prompt: 'next', timestamp: stamp(3) };
    const afterStop = { prompt: 'and now', timestamp: stamp(5) };
    for (const stopHookActive of [false, true]) {
      const stop = (reply, ...runs) => runWithResults(reply, runs, opts(repo, { stopHookActive }));
      quiet(stop('Done. REPORT sent.', ...written, ...answered));
      blocked(stop('Yes, it\'s done.', ...written, ...answered, afterStop), BIG_NAMES);
      blocked(stop('Yes, it\'s done.', ...written, typed), BIG_NAMES);
      quiet(stop('Yes, it\'s done.', ...written, ...bigDispatches(stamp(2)), ...answered, afterStop));
      quiet(stop('Yes, it\'s done.', ...written, ...bigDispatches(stamp(2)), typed));
    }
  });

  await t.test('a code turn inside the window a STOP-answering REPORT opened is checked, even after a planner NOTE; the same window with no write is quiet', () => {
    const repo = scratchRepo();
    const envelope = (body) => `<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n${body}\n</cross-session-message>`;
    const window = [
      { record: { type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${envelope('[STOP demo] Stop after this step and report.')}` } } },
      { sent: `[REPORT demo step 1] Stopped before step 2 started.\n${RAW_OUTPUT}`, output: 'Message sent to planner-1', timestamp: stamp(2) },
      { record: { type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${envelope('[NOTE demo] Carry on with step 2.')}` } } },
    ];
    const built = runWithResults('Done. Step 2 is built.', [...window, writeOf(repo, 'src/impl.ts', sourceLines(40), stamp(3))], opts(repo));
    assert.equal(built.status, 2, built.stderr);
    assert.match(built.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    quiet(runWithResults('Done. REPORT sent.', window, opts(repo)));
  });

  await t.test('on the retry a code turn inside a STOP-answered window is checked as on the first run, over Big writes with members unrun; the same window with no code edit is quiet', () => {
    const repo = scratchRepo();
    const envelope = (body) => `<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n${body}\n</cross-session-message>`;
    const window = [
      { record: { type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${envelope('[STOP demo] Stop after this step and report.')}` } } },
      { sent: `[REPORT demo step 1] Stopped before step 2 started.\n${RAW_OUTPUT}`, output: 'Message sent to planner-1', timestamp: stamp(2) },
      { record: { type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${envelope('[GO demo] Carry on with step 2.')}` } } },
    ];
    const retry = (reply, ...runs) => runWithResults(reply, [...window, ...runs], opts(repo, { stopHookActive: true }));
    blocked(retry('Done: step 2 built.', writeOf(repo, 'src/impl.ts', sourceLines(200), stamp(3))), BIG_NAMES);
    quiet(retry('Done. REPORT sent.'));
  });

  await t.test('on a code turn a hedge word does not void a claim; on a no-tool no-code turn it does', () => {
    const line = 'Done, nothing is left to be reviewed.';
    const codeClaim = runFull(line);
    assert.equal(codeClaim.status, 2, codeClaim.stderr);
    assert.match(codeClaim.stderr, /DONE-CLAIM WITHOUT EVIDENCE: the first line claims 'Done'/);
    const repo = scratchRepo();
    for (const text of [line, 'Not quite done.']) quiet(runWithResults(text, stopTurn(repo), opts(repo)));
  });

  await t.test('a claim is the first clause without a hedge; a first line ending in a question claims nothing', () => {
    const repo = scratchRepo();
    const reply = (text) => runWithResults(text, stopTurn(repo), opts(repo));
    blocked(reply('It\'s complete.'), BIG_NAMES);
    for (const text of ['Not quite done.', 'It isn\'t done yet.', 'Here\'s what\'s done and what\'s left:', 'The migration is almost complete.', 'Let me now complete the review.', 'The done-claim gate now checks REPORTs.', 'Is it done?']) quiet(reply(text));
  });

  await t.test('a claim clause ahead of a commit ask on the same line still claims; a lone question does not', () => {
    const repo = scratchRepo();
    const reply = (text) => runWithResults(text, stopTurn(repo), opts(repo));
    for (const text of ['Done — want me to commit?', 'Done and the suite is green, commit?', 'Done, should I commit?']) blocked(reply(text), BIG_NAMES);
    for (const text of ['Is it done?', 'Should I commit?', 'Is it done, should I commit?', 'Want me to mark it done, or keep going?']) quiet(reply(text));
    const code = runFull('Fixed the parser and tests pass, commit?');
    assert.equal(code.status, 2, code.stderr);
    assert.match(code.stderr, /DONE-CLAIM WITHOUT EVIDENCE: the first line claims 'Fixed'/);
    for (const text of ['If that works, should I commit?', 'Once the suite is green, want me to commit?']) assert.equal(runFull(text).status, 0, text);
  });

  await t.test('a code turn claiming "The refactor is complete." is blocked as a claim; "The complete list is below." is not', () => {
    const claim = runFull('The refactor is complete.');
    assert.equal(claim.status, 2, claim.stderr);
    assert.match(claim.stderr, /DONE-CLAIM WITHOUT EVIDENCE: the first line claims 'is complete'/);
    const list = runFull('The complete list is below.');
    assert.equal(list.status, 0, list.stderr);
  });

  await t.test('"Fixed: both bugs." after an agent dispatch over Big writes is blocked for the Big members; with no agent in the turn, the no-code claim set leaves it quiet', () => {
    const repo = scratchRepo();
    const agentTurn = (...earlier) => [...stopTurn(repo, ...earlier), dispatchOf('Explore', stamp(4))];
    blocked(runWithResults('Fixed: both bugs.', agentTurn(), opts(repo)), BIG_NAMES);
    quiet(runWithResults('Fixed: both bugs.', agentTurn(...bigDispatches(stamp(2))), opts(repo)));
    quiet(runWithResults('Fixed: both bugs.', stopTurn(repo), opts(repo)));
  });

  await t.test('empty stdin, or a retry with no transcript, exits 0', () => {
    for (const input of ['', JSON.stringify({ stop_hook_active: true })]) {
      assert.equal(spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8' }).status, 0, input);
    }
  });
});
