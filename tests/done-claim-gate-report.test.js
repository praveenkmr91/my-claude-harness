'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  HOOK_PATH, tmpDir, LENS_SKIPS, LEARN_SKIP, RAW_OUTPUT, LENS_AGENTS,
  handBack, repoWith, env, run, runFull, runWithResults,
} = require('./helpers/done-claim-gate');

test('done-claim gate: report', async (t) => {
  await t.test('a REPORT send is a done claim, checked before it leaves', () => {
    const built = { editedFile: null, handback: handBack('implementer'), send: true };
    const bare = runFull('[REPORT demo step 1] Step 1 built.', { ...built, lint: false });
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /REPORT WITHOUT RAW OUTPUT/);
    assert.match(bare.stderr, /DONE-CLAIM WITHOUT EVIDENCE: the first line claims 'REPORT'[^\n]*cite their output; for a REPORT, the lens lines go in the message itself\./);
    assert.match(bare.stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:[^\n]*the lens lines go in the message itself\./);
    assert.equal(run(`[REPORT demo step 1] Step 1 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`, { ...built, bashCommand: 'node --test tests/*.test.js' }), 0);
    assert.equal(run('[ASK demo step 1] Which file owns the type?', { ...built, lint: false }), 0);
  });

  await t.test('a REPORT counts a lint or type-check run as evidence; a Stop claim does not', () => {
    const opts = { editedFile: null, handback: handBack('implementer'), lint: false, bashCommand: 'pnpm lint && pnpm typecheck' };
    assert.equal(run(`[REPORT demo step 1] Step 1 renamed.\n${LENS_SKIPS}\n${RAW_OUTPUT}`, { ...opts, send: true }), 0);
    assert.match(runFull(`Done: step 1 renamed.\n${LENS_SKIPS}`, opts).stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
  });

  await t.test('a REPORT over a red test run is blocked even when a green lint came after it', () => {
    const report = `[REPORT demo step 1] Step 1 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const red = { command: 'node --test tests/*.test.js', isError: true, output: 'Exit code 1\nℹ fail 2' };
    const green = { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' };
    const lint = { command: 'pnpm lint', output: 'ok' };
    const opts = { send: true, lint: false, editedFile: null };
    const masked = runWithResults(report, [{ handback: handBack('implementer') }, red, lint], opts);
    assert.equal(masked.status, 2);
    assert.match(masked.stderr, /DONE-CLAIM OVER A FAILED RUN/);
    assert.equal(runWithResults(report, [{ handback: handBack('implementer') }, red, green, lint], opts).status, 0);
    assert.equal(runWithResults(report, [{ handback: handBack('implementer') }, green, lint], opts).status, 0);
  });

  await t.test('a REPORT reads its lens lines from the message, not from earlier chat text', () => {
    const body = `[REPORT demo step 1] Step 1 built.\n${RAW_OUTPUT}`;
    const tested = { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' };
    const chat = { blocks: [{ type: 'text', text: LENS_SKIPS }] };
    const opts = { send: true, lint: false, editedFile: null };
    const chatOnly = runWithResults(body, [{ handback: handBack('implementer') }, tested, chat], opts);
    assert.equal(chatOnly.status, 2);
    assert.match(chatOnly.stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:/);
    assert.equal(runWithResults(`${body}\n${LENS_SKIPS}`, [{ handback: handBack('implementer') }, tested, chat], opts).status, 0);
  });

  await t.test('on a built window a lens run needs its findings line in the REPORT; a skip line alone does', () => {
    const body = `[REPORT demo step 1] Step 1 built.\n${RAW_OUTPUT}`;
    const tested = { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' };
    const lensRuns = { blocks: LENS_AGENTS };
    const opts = { send: true, lint: false, editedFile: null };
    const runOnly = runWithResults(body, [{ handback: handBack('implementer') }, tested, lensRuns], opts);
    assert.equal(runOnly.status, 2);
    assert.match(runOnly.stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:/);
    assert.equal(runWithResults(`${body}\nreuse-analyzer: 0 findings\nplacement-analyzer: 2 findings`, [{ handback: handBack('implementer') }, tested, lensRuns], opts).status, 0);
    assert.equal(runWithResults(`${body}\n${LENS_SKIPS}`, [{ handback: handBack('implementer') }, tested], opts).status, 0);
  });

  await t.test('a REPORT with no build and no scratchpad path is blocked for the missing raw output alone', () => {
    const opts = { send: true, editedFile: null, bashCommand: 'node --test tests/*.test.js' };
    const bare = runFull(`[REPORT demo step 1] Step 1 checked.\n${LENS_SKIPS}`, opts);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /REPORT WITHOUT RAW OUTPUT/);
    assert.doesNotMatch(bare.stderr, /DONE-CLAIM|REVIEW NOT RUN|LINT\/TSC/);
    assert.equal(run(`[REPORT demo step 1] Step 1 checked.\n${LENS_SKIPS}\n${RAW_OUTPUT}`, opts), 0);
  });

  await t.test('a NOTE quoting a REPORT header is not a REPORT', () => {
    const note = '[NOTE demo step 1] The last message read [REPORT demo step 1]; ignore it.';
    assert.equal(run(note, { send: true, editedFile: null, handback: handBack('implementer'), lint: false }), 0);
  });

  await t.test('a REPORT header is the first line minus markdown and quote marks, case-insensitive', () => {
    const opts = { send: true, editedFile: null, handback: handBack('implementer'), lint: false };
    for (const message of ['**[REPORT demo step 1]** Step 1 built.', '[Report demo step 1] Step 1 built.', '> `[REPORT demo step 1]` Step 1 built.', '\n## [ REPORT demo step 1] Step 1 built.']) {
      assert.equal(run(message, opts), 2, message);
    }
    assert.equal(run('FYI the planner wants a [REPORT demo step 1] soon.', opts), 0);
    assert.equal(run('[REPORTS demo] not a header.', opts), 0);
  });

  await t.test('a REPORT with no hand-back and no code edit is quiet', () => {
    assert.equal(run(`[REPORT demo step 1] Nothing to build.\n${RAW_OUTPUT}`, { send: true, editedFile: null, lint: false }), 0);
  });

  await t.test('a REPORT after a main-thread in-place code edit is a claim', () => {
    const body = `[REPORT demo step 1] Step 1 built.\n${RAW_OUTPUT}`;
    const opts = { send: true, editedFile: null, lint: false, bashCommand: "sed -i '' s/a/b/ src/app.ts" };
    const { status, stderr } = runFull(body, opts);
    assert.equal(status, 2);
    assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:/);
  });

  await t.test('a REPORT answering a STOP, with nothing built since the last REPORT, is quiet but still needs its raw output', () => {
    const opts = { send: true, editedFile: null, lint: false };
    const stop = '[REPORT demo step 2] Stopped before step 2 started; nothing built since step 1.';
    assert.equal(run(`${stop}\n${RAW_OUTPUT}`, opts), 0);
    const bare = runFull(stop, opts);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /REPORT WITHOUT RAW OUTPUT/);
    assert.doesNotMatch(bare.stderr, /DONE-CLAIM|REVIEW NOT RUN/);
  });

  await t.test('a REPORT counts only the checks that ran after the last implementer hand-back', () => {
    const report = `[REPORT demo step 2] Step 2 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const tested = { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' };
    const opts = { send: true, lint: false, editedFile: null };
    const stale = runWithResults(report, [tested, { handback: handBack('implementer') }], opts);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.equal(runWithResults(report, [{ handback: handBack('implementer') }, tested], opts).status, 0);
    const redBefore = { command: 'node --test tests/*.test.js', isError: true, output: 'Exit code 1\nℹ fail 2' };
    assert.equal(runWithResults(report, [redBefore, { handback: handBack('implementer') }, tested], opts).status, 0);
  });

  await t.test('a REPORT needs its lint and type check after the last hand-back', () => {
    const report = `[REPORT demo step 2] Step 2 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const linted = { command: 'pnpm lint && npx tsc --noEmit', output: 'ok' };
    const tested = { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' };
    const opts = { send: true, lint: false, editedFile: null, cwd: repoWith({ lint: 'eslint .' }) };
    const stale = runWithResults(report, [{ handback: handBack('implementer') }, linted, { handback: handBack('implementer') }, tested], opts);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /LINT\/TSC NOT RUN/);
    const fresh = runWithResults(report, [{ handback: handBack('implementer') }, { handback: handBack('implementer') }, tested, linted], opts);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stderr, /LINT\/TSC/);
  });

  await t.test('the REPORT window runs from the previous sent REPORT, not the typed prompt', () => {
    const report = `[REPORT demo step 1] Step 1 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const opts = { send: true, lint: false, editedFile: null };
    const granted = runWithResults(report, [{ handback: handBack('implementer') }, { prompt: 'granted' }], opts);
    assert.equal(granted.status, 2);
    assert.match(granted.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    const blocked = { sent: report, isError: true, output: 'PreToolUse:SendMessage hook error: DONE-CLAIM WITHOUT EVIDENCE' };
    assert.equal(runWithResults(report, [{ handback: handBack('implementer') }, blocked], opts).status, 2);
    const checked = [{ handback: handBack('implementer') }, { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' }, blocked];
    const reworded = runWithResults(`[REPORT demo step 1] Step 1 built and checked.\n${RAW_OUTPUT}`, checked, { ...opts, lint: true });
    assert.equal(reworded.status, 2);
    assert.match(reworded.stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:/);
    const delivered = { sent: report, output: 'Message sent to planner-1' };
    const afterDelivery = runWithResults(`[REPORT demo step 2] Nothing built since step 1.\n${RAW_OUTPUT}`, [{ handback: handBack('implementer') }, delivered], opts);
    assert.equal(afterDelivery.status, 0, afterDelivery.stderr);
  });

  await t.test('a REPORT is reviewed by the lenses of the files changed since the previous REPORT commit, not the branch', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' }).stdout.trim();
    const commit = (file, subject) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), 'export const a = 1;\n');
      git('add', '.');
      git('commit', '-q', '-m', subject);
      return `[master ${git('rev-parse', '--short', 'HEAD')}] ${subject}`;
    };
    git('init', '-q');
    const step1Output = commit('src/a.tsx', 'step 1');
    const step2Output = commit('docs/b.md', 'step 2');
    const report = `[REPORT demo step 2] Step 2 built.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings\n${RAW_OUTPUT}`;
    const delivered = { sent: '[REPORT demo step 1] Step 1 built.', output: 'Message sent to planner-1' };
    const step2 = [
      { handback: handBack('implementer') },
      { blocks: LENS_AGENTS },
      { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' },
      { command: 'git commit -m "step 2"', output: step2Output },
    ];
    const opts = { send: true, lint: false, editedFile: null, cwd: repo, since: '2020-01-01T00:00:00.000Z' };
    const step1 = (output) => ({ command: 'git commit -m "step 1"', output });
    const branchWide = runWithResults(report, [step1(step1Output), ...step2], opts);
    assert.equal(branchWide.status, 2);
    assert.match(branchWide.stderr, /REVIEW NOT RUN for react-best-practices:/);
    const stepOnly = runWithResults(report, [step1(step1Output), delivered, ...step2], opts);
    assert.equal(stepOnly.status, 0, stepOnly.stderr);
    const unresolvable = runWithResults(report, [step1('[master deadbee] step 1'), delivered, ...step2], opts);
    assert.equal(unresolvable.status, 2);
    assert.match(unresolvable.stderr, /REVIEW NOT RUN for react-best-practices:/);
  });

  const styledTurn = (runs) => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
    spawnSync('git', ['init', '-q'], { cwd: repo, env });
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/a.tsx'), 'export const A = () => <div className="p-4" />;\n');
    const reply = 'Done: the card is styled.\nreact-best-practices: 0 findings\nimpeccable: 0 findings';
    return runWithResults(reply, [{ command: 'node --test tests/*.test.js', output: 'ℹ fail 0' }, ...runs], { editedFile: path.join(repo, 'src/a.tsx'), cwd: repo });
  };

  await t.test('a styled change blocks on a hand-written impeccable line', () => {
    const { status, stderr } = styledTurn([]);
    assert.equal(status, 2);
    assert.match(stderr, /IMPECCABLE NOT RUN/);
  });

  await t.test('a styled change passes once the impeccable audit skill ran', () => {
    const audit = { type: 'tool_use', name: 'Skill', input: { skill: 'impeccable:impeccable', args: 'audit src/a.tsx' } };
    const { status, stderr } = styledTurn([{ blocks: [audit] }]);
    assert.doesNotMatch(stderr, /IMPECCABLE NOT RUN/);
    assert.equal(status, 0, stderr);
  });

  await t.test('at Stop, a built step commit passes on a hand-pass lens line, with or without a sent REPORT, and blocks with no lens line', () => {
    const report = `[REPORT demo step 1] Step 1 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const runs = [
      { handback: handBack('implementer') },
      { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' },
      { sent: report, output: 'Message sent to planner-1' },
      { command: 'git commit -m x', output: '' },
    ];
    assert.equal(runWithResults('Committed as abc1234.', runs).status, 0);
    const unreported = runWithResults('Committed as abc1234.', runs.filter((r) => !r.sent));
    assert.equal(unreported.status, 0, unreported.stderr);
    const noLensLine = runFull('Committed as abc1234.', { editedFile: null, lint: false, handback: handBack('implementer'), bashCommand: 'git commit -m x' });
    assert.equal(noLensLine.status, 2);
    assert.match(noLensLine.stderr, /REVIEW NOT RUN for reuse-analyzer/);
  });

  await t.test('at Stop, a delivered REPORT closes the window and a blocked one keeps it', () => {
    const report = `[REPORT demo step 1] Step 1 built.\n${RAW_OUTPUT}`;
    const base = [{ handback: handBack('implementer') }, { command: 'git commit -m x', output: '' }];
    const opts = { lint: false, editedFile: null };
    const blocked = runWithResults('Done: step 1 committed.', [...base, { sent: report, isError: true, output: 'PreToolUse:SendMessage hook error: REVIEW NOT RUN' }], opts);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /REVIEW NOT RUN for reuse-analyzer:/);
    const delivered = runWithResults('Done: step 1 committed.', [...base, { sent: report, output: 'Message sent to planner-1' }], opts);
    assert.equal(delivered.status, 0, delivered.stderr);
  });

  await t.test('a REPORT answering a STOP is checked for its raw output alone', () => {
    const report = `[REPORT demo step 1] Step 1 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const stopEnvelope = '<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n[STOP demo] Stop after this step and report.\n</cross-session-message>';
    const stopMsg = { type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${stopEnvelope}` } };
    const stopAttachment = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, prompt: stopEnvelope } };
    const redCheck = { command: 'pnpm verify', isError: true, output: 'Exit code 1\nℹ fail 1' };
    const opts = { send: true, lint: false, editedFile: null };
    const build = [{ handback: handBack('implementer') }, redCheck];
    const unstopped = runWithResults(report, build, opts);
    assert.equal(unstopped.status, 2);
    assert.match(unstopped.stderr, /DONE-CLAIM OVER A FAILED RUN/);
    const stopped = runWithResults(report, [...build, { record: stopMsg }], opts);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(runWithResults(report, [...build, { record: stopAttachment }], opts).status, 0);
    const noRawOutput = runWithResults(`[REPORT demo step 1] Stopped mid-step.\n${LENS_SKIPS}`, [...build, { record: stopMsg }], opts);
    assert.equal(noRawOutput.status, 2);
    assert.match(noRawOutput.stderr, /REPORT WITHOUT RAW OUTPUT/);
  });

  await t.test('a queued message with a pasted image does not crash the gate', () => {
    const imageAttachment = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: '[Image #2]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }] } };
    const result = runWithResults('Looking at the screenshot now.', [{ record: imageAttachment }], { lint: false, editedFile: null });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });

  await t.test('a peer STOP queued alongside an image still counts as a stop', () => {
    const report = `[REPORT demo step 1] Step 1 built.\n${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const stopEnvelope = '<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n[STOP demo] Stop after this step and report.\n</cross-session-message>';
    const stopAttachment = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, prompt: [{ type: 'text', text: stopEnvelope }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }] } };
    const redCheck = { command: 'pnpm verify', isError: true, output: 'Exit code 1\nℹ fail 1' };
    const opts = { send: true, lint: false, editedFile: null };
    const build = [{ handback: handBack('implementer') }, redCheck];
    assert.equal(runWithResults(report, [...build, { record: stopAttachment }], opts).status, 0);
  });

  await t.test('a REPORT over a red test run passes only with an expected-red line of four or more words', () => {
    const redTest = { command: 'pnpm exec playwright test e2e/x.spec.ts', isError: true, output: 'Exit code 1\n  1 failed' };
    const redLint = { command: 'pnpm lint', isError: true, output: 'Exit code 1' };
    const opts = { send: true, lint: false, editedFile: null };
    const body = (expected, header = '[REPORT demo step 5]') => `${header} Step built.\n${expected ? `expected red: ${expected}\n` : ''}${LENS_SKIPS}\n${RAW_OUTPUT}`;
    const attempt = (message, runs = [{ handback: handBack('implementer') }, redTest], extra = opts) => runWithResults(message, runs, extra);

    const passes = attempt(body('the scroll case fails before the fix'));
    assert.equal(passes.status, 0, passes.stderr);
    const bare = attempt(body());
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /DONE-CLAIM OVER A FAILED RUN[^\n]*expected red: <what fails and why the plan expects it>/);

    const lintRed = attempt(body('the scroll case fails before the fix'), [{ handback: handBack('implementer') }, redTest, redLint]);
    assert.equal(lintRed.status, 2);
    assert.match(lintRed.stderr, /DONE-CLAIM OVER A FAILED RUN/);

    const short = attempt(body('scroll case fails'));
    assert.equal(short.status, 2);
    assert.match(short.stderr, /DONE-CLAIM OVER A FAILED RUN/);
    assert.equal(attempt(body('scroll case fails first')).status, 0);

    const claim = attempt('Done: step built.\nexpected red: the scroll case fails before the fix', [{ handback: handBack('implementer') }, redTest], { lint: false, editedFile: null });
    assert.equal(claim.status, 2);
    assert.match(claim.stderr, /DONE-CLAIM OVER A FAILED RUN/);
  });

  await t.test('a compaction summary is not a typed prompt, so it keeps the lens dispatches', () => {
    const compaction = { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation.' } };
    const built = (between) => [{ blocks: LENS_AGENTS }, between, { handback: handBack('implementer') }, { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' }];
    const opts = { lint: false, editedFile: null };
    const typed = runWithResults('Done: step built.', built({ prompt: 'next' }), opts);
    assert.equal(typed.status, 2);
    assert.match(typed.stderr, /REVIEW NOT RUN for reuse-analyzer:/);
    const compacted = runWithResults(`Done: step built.\n${LEARN_SKIP}`, built({ record: compaction }), opts);
    assert.doesNotMatch(compacted.stderr, /REVIEW NOT RUN/);
    assert.equal(compacted.status, 0, compacted.stderr);
  });

  await t.test('an empty payload or an empty SendMessage passes', () => {
    assert.equal(spawnSync('bash', [HOOK_PATH], { input: '{}', encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ tool_name: 'SendMessage', tool_input: {} }), encoding: 'utf8' }).status, 0);
  });

  await t.test('empty stdin or a missing transcript exits 0 with no output', () => {
    const missingTranscript = JSON.stringify({ transcript_path: path.join(os.tmpdir(), 'done-claim-gate-no-such-transcript.jsonl') });
    for (const input of ['', 'null', missingTranscript]) {
      const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8' });
      assert.deepEqual([res.status, res.stdout, res.stderr], [0, '', ''], input);
    }
  });

  await t.test('skips the retry after a block', () => {
    assert.equal(run('Done.', { stopHookActive: true }), 0);
  });
});
