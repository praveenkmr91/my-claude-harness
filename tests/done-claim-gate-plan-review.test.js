'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  HOOK_PATH, tmpDir, LENS_SKIPS, LEARN_SKIP, RAW_OUTPUT, handBack, env, nextSeq, runWithResults,
} = require('./helpers/done-claim-gate');

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
  const authorReview = { type: 'text', text: 'Pass: review — steps re-read against the tree, no gaps.' };
  const readPlan = (file = PLAN) => ({ type: 'tool_use', name: 'Read', input: { file_path: file } });
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

  await t.test('an edit after the cold read leaves (A) quiet and owes only the author review, quiet once a read and `Pass: review` follow the edit', () => {
    const blocks = [writePlan(), review('cold-reader', PLAN), advisor, editPlan()];
    const fires = runPlan(turn(blocks, asks.typeRepo), asks.typeRepo);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(C\)/);
    assert.doesNotMatch(fires.stderr, /\(A\)/);
    assert.doesNotMatch(fires.stderr, /\(B\)/);
    const quiet = runPlan(turn([...blocks, readPlan(), authorReview], asks.typeRepo), asks.typeRepo);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a dry-runner alone is no review: (A) fires, and a cold-reader on the same plan clears it', () => {
    const dryOnly = runPlan(turn([writePlan(), review('dry-runner', `Dry-run ${PLAN}`), advisor, readPlan(), authorReview], asks.type), asks.type);
    assert.equal(dryOnly.status, 2, dryOnly.stderr);
    assert.match(dryOnly.stderr, /\(A\) no cold-reader ran on it/);
    const coldRead = runPlan(turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`), advisor, readPlan(), authorReview], asks.type), asks.type);
    assert.equal(coldRead.status, 0, coldRead.stderr);
  });

  await t.test('blocks a reviewed plan with no advisor after its first review, quiet once the advisor ran', () => {
    const blocks = [writePlan(), review('cold-reader', `Cold-read ${PLAN}`)];
    const fires = runPlan(turn(blocks, asks.say), asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(B\)/);
    assert.doesNotMatch(fires.stderr, /\(A\)/);
    assert.equal(runPlan(turn([...blocks, advisor, readPlan(), authorReview], asks.say), asks.say).status, 0);
  });

  await t.test('a review that names another plan does not cover this one, and a plugin-prefixed reviewer type counts', () => {
    const other = runPlan(turn([writePlan(), review('cold-reader', '/repo/docs/plans/other.md'), advisor], asks.type), asks.type);
    assert.equal(other.status, 2, other.stderr);
    assert.match(other.stderr, /\(A\)/);
    const prefixed = runPlan(turn([writePlan(), review('hera:cold-reader', `Cold-read ${PLAN}`), advisor, readPlan(), authorReview], asks.type), asks.type);
    assert.equal(prefixed.status, 0, prefixed.stderr);
  });

  await t.test('a cold read of `build-ui.md` does not cover `ui.md`, one naming `ui.md` does', () => {
    const UI = '/h/.claude/plans/ui.md';
    const sibling = [prompt('plan A'), assistant(writePlan('/h/.claude/plans/build-ui.md'), review('cold-reader', '/h/.claude/plans/build-ui.md'), advisor), prompt('plan B')];
    const planB = assistant(writePlan(UI), readPlan(UI), authorReview);
    const final = assistant({ type: 'text', text: asks.type });
    const fires = runPlan([...sibling, planB, final], asks.type);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(A\)/);
    const named = [prompt('plan A'), assistant(writePlan('/h/.claude/plans/other.md'), review('cold-reader', `Cold-read ui.md in ${UI}`), advisor), prompt('plan B')];
    const quiet = runPlan([...named, planB, final], asks.type);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a cold-reader dispatch that errored is no review, the same dispatch with a clean result is', () => {
    const tail = [advisor, readPlan(), authorReview];
    const errored = runPlan([prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN, 'tu-c')), toolResult('tu-c', true), assistant(...tail), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(errored.status, 2, errored.stderr);
    assert.match(errored.stderr, /\(A\)/);
    const clean = runPlan([prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN, 'tu-c')), toolResult('tu-c', false), assistant(...tail), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(clean.status, 0, clean.stderr);
  });

  await t.test('a cold read of the plan under ~/.claude/plans still covers it once it moves to docs/plans', () => {
    const moved = [writePlan(), review('cold-reader', PLAN), advisor, editPlan('/repo/docs/plans/x.md'), readPlan('/repo/docs/plans/x.md'), authorReview];
    const quiet = runPlan(turn(moved, asks.typeRepo), asks.typeRepo);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a `plan gate: skip — <reason>` line in the turn suppresses the block', () => {
    const reply = `plan gate: skip — trivial one-line plan\n${asks.type}`;
    assert.equal(runPlan(turn([writePlan()], reply), reply).status, 0);
    const bare = 'plan gate: skip\n' + asks.type;
    assert.equal(runPlan(turn([writePlan()], bare), bare).status, 2);
  });

  await t.test('no plan edit, or edits only to a research note, leave the implement ask alone', () => {
    assert.equal(runPlan(turn([], asks.type), asks.type).status, 0);
    assert.equal(runPlan(turn([writePlan('/h/.claude/plans/x.research.md')], asks.type), asks.type).status, 0);
  });

  await t.test('tracking spans turns: a review in turn 1 covers an ask in turn 2, a plan edit in turn 2 owes only the author review', () => {
    const turn1 = [prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN), advisor, readPlan(), authorReview), assistant({ type: 'text', text: 'Plan is ready.' })];
    const quiet = runPlan([...turn1, prompt('looks good'), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(quiet.status, 0, quiet.stderr);
    const fires = runPlan([...turn1, prompt('change step 2'), assistant(editPlan()), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(C\)/);
    assert.doesNotMatch(fires.stderr, /\(A\)/);
  });

  await t.test('an empty transcript, and a plan reply with no implement ask, pass', () => {
    const empty = runPlan([], asks.type);
    assert.equal(empty.status, 0, empty.stderr);
    const noAsk = runPlan(turn([writePlan()], 'The plan is written to x.md.'), 'The plan is written to x.md.');
    assert.equal(noAsk.status, 0, noAsk.stderr);
  });

  await t.test('a Fable thread\'s plan ask needs no advisor consult', () => {
    const records = [...onModel('claude-fable-5-2', turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`), readPlan(), authorReview], asks.say)), interrupt];
    const quiet = runPlan(records, asks.say);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a Fable thread\'s plan ask after an edit owes the author review, not a new cold read', () => {
    const records = [...onModel('claude-fable-5-2', turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`), editPlan()], asks.say)), interrupt];
    const fires = runPlan(records, asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(C\)/);
    assert.doesNotMatch(fires.stderr, /\(A\)/);
    assert.doesNotMatch(fires.stderr, /\(B\)/);
  });

  await t.test('an Opus thread\'s plan ask still needs the advisor consult', () => {
    const fires = runPlan(onModel('claude-opus-5-5', turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`)], asks.say)), asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(B\)/);
  });

  await t.test('blocks a reviewed plan with no `Pass: review` of its own after the last edit, on every model', () => {
    const blocks = [writePlan(), review('cold-reader', `Cold-read ${PLAN}`), advisor];
    const fires = runPlan(turn(blocks, asks.type), asks.type);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(C\)/);
    assert.doesNotMatch(fires.stderr, /\(A\)/);
    assert.doesNotMatch(fires.stderr, /\(B\)/);
    assert.equal(runPlan(turn([...blocks, readPlan(), authorReview], asks.type), asks.type).status, 0);
    const unread = runPlan(turn([...blocks, authorReview], asks.type), asks.type);
    assert.equal(unread.status, 2, unread.stderr);
    assert.match(unread.stderr, /\(C\)/);
    assert.doesNotMatch(unread.stderr, /\(A\)/);
    assert.doesNotMatch(unread.stderr, /\(B\)/);
    const otherRead = runPlan(turn([...blocks, readPlan('/h/.claude/plans/other.md'), authorReview], asks.type), asks.type);
    assert.equal(otherRead.status, 2, otherRead.stderr);
    assert.match(otherRead.stderr, /\(C\)/);
    const lineBeforeRead = runPlan(turn([...blocks, authorReview, readPlan()], asks.type), asks.type);
    assert.equal(lineBeforeRead.status, 2, lineBeforeRead.stderr);
    assert.match(lineBeforeRead.stderr, /\(C\)/);
    const staleRead = runPlan(turn([writePlan(), review('cold-reader', `Cold-read ${PLAN}`), advisor, readPlan(), editPlan(), review('cold-reader', `Cold-read ${PLAN}`), authorReview], asks.type), asks.type);
    assert.equal(staleRead.status, 2, staleRead.stderr);
    assert.match(staleRead.stderr, /\(C\)/);
    assert.doesNotMatch(staleRead.stderr, /\(A\)/);
    assert.doesNotMatch(staleRead.stderr, /\(B\)/);
    const stale =runPlan(turn([writePlan(), authorReview, review('cold-reader', `Cold-read ${PLAN}`), advisor, editPlan(), review('cold-reader', `Cold-read ${PLAN}`)], asks.type), asks.type);
    assert.equal(stale.status, 2, stale.stderr);
    assert.match(stale.stderr, /\(C\)/);
    assert.doesNotMatch(stale.stderr, /\(A\)/);
    assert.doesNotMatch(stale.stderr, /\(B\)/);
    const withLine = `Pass: review — no gaps.\n\n${asks.type}`;
    const unflushed = runPlan([prompt('plan it'), assistant(...blocks, readPlan())], withLine);
    assert.equal(unflushed.status, 0, unflushed.stderr);
    const unflushedUnread = runPlan([prompt('plan it'), assistant(...blocks)], withLine);
    assert.equal(unflushedUnread.status, 2, unflushedUnread.stderr);
    assert.match(unflushedUnread.stderr, /\(C\)/);
    const fable = runPlan(onModel('claude-fable-5-2', turn(blocks, asks.type)), asks.type);
    assert.equal(fable.status, 2, fable.stderr);
    assert.match(fable.stderr, /\(C\)/);
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

test('done-claim gate: required review agents', async (t) => {
  const stamp = (seconds = 0) => new Date(Date.UTC(2099, 0, 1, 0, 0, seconds)).toISOString();
  const sourceLines = (count, first = 'export const v0 = 0;') => [first, ...Array.from({ length: count - 1 }, (_, i) => `export const v${i + 1} = ${i + 1};`)].join('\n') + '\n';
  const withCatch = 'try { run(); } catch (e) { report(e); }';
  const CLAIM = 'Done: the edits landed.';
  const ASK = 'Diff is above.\nSay yes and I will commit.';
  const NOT_RUN = /REVIEW AGENTS NOT RUN/;

  const scratchRepo = () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
    spawnSync('git', ['init', '-q'], { cwd: repo, env });
    return repo;
  };
  const writeOf = (repo, file, content, timestamp) => ({ blocks: [{ type: 'tool_use', id: `write-${file}`, name: 'Write', input: { file_path: path.join(repo, file), content } }], timestamp });
  const dispatchOf = (member, timestamp, id = `dispatch-${member}`) => ({ blocks: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: member, description: 'review', prompt: 'review', effort: 'low' } }], timestamp });
  const skillOf = (skill, timestamp, id = `skill-${skill}`) => ({ blocks: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }], timestamp });
  const resultOf = (id, isError, timestamp, text = 'out') => ({ record: { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } } });
  const checked = (timestamp) => ({ command: 'pnpm lint && node --test tests/*.test.js', output: 'ℹ fail 0', timestamp });
  const committed = (timestamp) => ({ command: 'git commit -m x', output: '', timestamp });
  const feedbackOf = (text) => ({ record: { type: 'user', isMeta: true, message: { content: `Stop hook feedback:\n[bash …/done-claim-gate.sh]: ${text}` } } });
  const agentFeedback = () => feedbackOf('REVIEW AGENTS NOT RUN for code-reviewer: source written in this session still owes each an agent run.');
  const opts = (repo, extra) => ({ cwd: repo, since: stamp(0), lint: false, editedFile: null, ...extra });
  const blocked = (res, members) => {
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, new RegExp(`REVIEW AGENTS NOT RUN for ${members}:`));
  };
  const quiet = (res) => {
    assert.doesNotMatch(res.stderr, NOT_RUN);
    assert.equal(res.status, 0, res.stderr);
  };

  await t.test('a claim over 30 unreviewed lines needs code-reviewer dispatched as an agent', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const fires = runWithResults(CLAIM, [thirty, checked(stamp(3))], opts(repo));
    blocked(fires, 'code-reviewer');
    assert.match(fires.stderr, /: source written in this session still owes each a run\. Run `delete-list` and `security-review` as `Skill` calls and the rest as agents, each with an `effort`/);
    quiet(runWithResults(CLAIM, [thirty, dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo)));
    for (const line of ['code-reviewer: 0 findings', 'code-reviewer: skip — reviewed by hand', 'code-reviewer: not run — small change']) {
      blocked(runWithResults(`${CLAIM}\n${line}`, [thirty, checked(stamp(3))], opts(repo)), 'code-reviewer');
    }
  });

  const BIG_MEMBERS = ['silent-failure-hunter', 'type-design-analyzer', 'reuse-analyzer', 'placement-analyzer', 'delete-list', 'adversarial-reviewer', 'security-review'];
  const SKILL_BIG = ['delete-list', 'security-review'];
  const bigDispatches = (timestamp, without) => BIG_MEMBERS.filter((member) => member !== without).map((member) => (SKILL_BIG.includes(member) ? skillOf(member, timestamp) : dispatchOf(member, timestamp)));

  await t.test('a claim over 200 unreviewed lines with code-reviewer dispatched is blocked for the seven Big members alone', () => {
    const repo = scratchRepo();
    const big = writeOf(repo, 'impl.ts', sourceLines(200), stamp(1));
    const fires = runWithResults(CLAIM, [big, dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo));
    blocked(fires, BIG_MEMBERS.join(', '));
    const message = fires.stderr.split('\n').find((line) => NOT_RUN.test(line));
    assert.doesNotMatch(message, /code-reviewer/);
    assert.match(message, /Give each everything written since its last run, never the last commit alone\.$/);
  });

  await t.test('a claim over 200 lines is quiet once code-reviewer and the seven Big members ran after the write', () => {
    const repo = scratchRepo();
    const dispatches = [dispatchOf('code-reviewer', stamp(2)), ...bigDispatches(stamp(2))];
    quiet(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), ...dispatches, checked(stamp(3))], opts(repo)));
  });

  await t.test('a claim over 250 lines with the five agent members run owes delete-list and security-review until a Skill call clears them', () => {
    const repo = scratchRepo();
    const agentRuns = ['code-reviewer', ...BIG_MEMBERS.filter((member) => !SKILL_BIG.includes(member))].map((member) => dispatchOf(member, stamp(2)));
    const written = writeOf(repo, 'impl.ts', sourceLines(250), stamp(1));
    const typedLines = `${CLAIM}\ndelete-list: 0 findings\nsecurity-review: skip — reviewed by hand`;
    blocked(runWithResults(typedLines, [written, ...agentRuns, checked(stamp(3))], opts(repo)), 'delete-list, security-review');
    const asAgents = SKILL_BIG.map((member) => dispatchOf(member, stamp(2)));
    blocked(runWithResults(CLAIM, [written, ...agentRuns, ...asAgents, checked(stamp(3))], opts(repo)), 'delete-list, security-review');
    const typedCommand = { record: { type: 'user', timestamp: stamp(2), message: { content: '<command-name>/delete-list</command-name>' } } };
    blocked(runWithResults(CLAIM, [written, ...agentRuns, typedCommand, checked(stamp(3))], opts(repo)), 'delete-list, security-review');
    blocked(runWithResults(CLAIM, [written, ...agentRuns, skillOf('delete-list', stamp(2)), checked(stamp(3))], opts(repo)), 'security-review');
    quiet(runWithResults(CLAIM, [written, ...agentRuns, ...SKILL_BIG.map((member) => skillOf(member, stamp(2))), checked(stamp(3))], opts(repo)));
  });

  await t.test('a Skill call before the last write clears nothing; an errored one clears nothing', () => {
    const repo = scratchRepo();
    const agentRuns = ['code-reviewer', ...BIG_MEMBERS.filter((member) => !SKILL_BIG.includes(member))].map((member) => dispatchOf(member, stamp(2)));
    const skills = (timestamp) => SKILL_BIG.map((member) => skillOf(member, timestamp));
    blocked(runWithResults(CLAIM, [...skills(stamp(0)), writeOf(repo, 'impl.ts', sourceLines(250), stamp(1)), ...agentRuns, checked(stamp(3))], opts(repo)), 'delete-list, security-review');
    const errored = [...skills(stamp(2)), resultOf('skill-delete-list', true, stamp(2)), resultOf('skill-security-review', true, stamp(2))];
    blocked(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(250), stamp(1)), ...agentRuns, ...errored, checked(stamp(3))], opts(repo)), 'delete-list, security-review');
  });

  const reviewerShown = (...shown) => {
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    const agentDir = path.join(tmpDir, path.basename(transcriptPath, '.jsonl'), 'subagents');
    fs.mkdirSync(agentDir, { recursive: true });
    const records = [
      { type: 'user', message: { role: 'user', content: 'review the change' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `opened ${shown.join(' ')}` }] } },
    ];
    fs.writeFileSync(path.join(agentDir, 'agent-r1.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'));
    return transcriptPath;
  };
  const bigRuns = (repo, files, { linked = false, without } = {}) => {
    const writes = files.map(([name, count]) => {
      fs.writeFileSync(path.join(repo, name), sourceLines(count));
      return writeOf(repo, name, sourceLines(count), stamp(1));
    });
    const dispatches = [dispatchOf('code-reviewer', stamp(2)), ...bigDispatches(stamp(2), without)];
    const link = linked ? [resultOf('dispatch-reuse-analyzer', false, stamp(2), 'done\nagentId: r1 (use SendMessage to continue)')] : [];
    return [...writes, ...dispatches, ...link, checked(stamp(3))];
  };
  const TWO_FILES = [['a.ts', 200], ['b.ts', 200]];
  const BULK_CLAIM = `${CLAIM}\ndelete-list: skip — fixture files`;

  await t.test('a Big member whose linked run was shown only some of the files is blocked, with the unshown file named', () => {
    const repo = scratchRepo();
    const fires = runWithResults(BULK_CLAIM, bigRuns(repo, TWO_FILES, { linked: true }), opts(repo, { transcriptPath: reviewerShown('a.ts') }));
    blocked(fires, 'reuse-analyzer');
    assert.ok(fires.stderr.split('\n').includes('reuse-analyzer has not been shown: b.ts.'), fires.stderr);
  });

  await t.test('quiet: the same run shown both files', () => {
    const repo = scratchRepo();
    quiet(runWithResults(BULK_CLAIM, bigRuns(repo, TWO_FILES, { linked: true }), opts(repo, { transcriptPath: reviewerShown('a.ts', 'b.ts') })));
  });

  await t.test('the unshown block still holds once two such blocks are in the window; a run shown both files is quiet', () => {
    const repo = scratchRepo();
    const runs = [...bigRuns(repo, TWO_FILES, { linked: true }), agentFeedback(), agentFeedback()];
    const fires = runWithResults(BULK_CLAIM, runs, opts(repo, { transcriptPath: reviewerShown('a.ts') }));
    blocked(fires, 'reuse-analyzer');
    assert.ok(fires.stderr.split('\n').includes('reuse-analyzer has not been shown: b.ts.'), fires.stderr);
    quiet(runWithResults(BULK_CLAIM, runs, opts(repo, { transcriptPath: reviewerShown('a.ts', 'b.ts') })));
  });

  await t.test('a Big member with no dispatch in the turn is named with its files', () => {
    const repo = scratchRepo();
    const fires = runWithResults(BULK_CLAIM, bigRuns(repo, TWO_FILES, { without: 'type-design-analyzer' }), opts(repo));
    blocked(fires, 'type-design-analyzer');
    assert.ok(fires.stderr.split('\n').includes('type-design-analyzer has not been shown: a.ts, b.ts.'), fires.stderr);
  });

  await t.test('seven unshown files: five are named, decoded, and the rest counted', () => {
    const repo = scratchRepo();
    const files = [['my file.ts', 220], ...[1, 2, 3, 4, 5, 6].map((n) => [`f${n}.ts`, 200])];
    const fires = runWithResults(BULK_CLAIM, bigRuns(repo, files, { without: 'reuse-analyzer' }), opts(repo));
    blocked(fires, 'reuse-analyzer');
    assert.ok(fires.stderr.split('\n').includes('reuse-analyzer has not been shown: my file.ts, f1.ts, f2.ts, f3.ts, f4.ts and 2 more.'), fires.stderr);
  });

  await t.test('a later typed turn that only commits is blocked for the Big members when the earlier turn dispatched code-reviewer alone', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), dispatchOf('code-reviewer', stamp(2)), { prompt: 'next', timestamp: stamp(3) }, committed(stamp(5))];
    blocked(runWithResults('Committed as abc1234.', runs, opts(repo)), BIG_MEMBERS.join(', '));
  });

  await t.test('a later typed turn that runs the Big members and commits is quiet', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), dispatchOf('code-reviewer', stamp(2)), { prompt: 'next', timestamp: stamp(3) }, ...bigDispatches(stamp(4)), committed(stamp(5))];
    quiet(runWithResults('Committed as abc1234.', runs, opts(repo)));
  });

  await t.test('a dispatch with an errored result leaves its member in the block', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(2), 'review'), resultOf('review', true, stamp(2)), checked(stamp(3))];
    blocked(runWithResults(CLAIM, runs, opts(repo)), 'code-reviewer');
    runs[2] = resultOf('review', false, stamp(2));
    quiet(runWithResults(CLAIM, runs, opts(repo)));
  });

  for (const [outcome, stub, warning] of [
    ['fails', 'import sys\nprint("boom", file=sys.stderr)\n', 'review-classify failed: boom'],
    ['runs past its limit', 'import time\ntime.sleep(8)\n', 'review-classify timed out after 6s; review joins skipped'],
  ]) {
    await t.test(`a classifier that ${outcome} blocks nothing and warns the user once`, () => {
      const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
      fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'hooks', 'review-classify.py'), stub);
      const repo = scratchRepo();
      const res = runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), checked(stamp(3))], opts(repo, { home }));
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), { systemMessage: warning });
    });
  }

  await t.test('a signalled member is named alone once code-reviewer was dispatched', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30, withCatch), stamp(1)), checked(stamp(3))];
    blocked(runWithResults(CLAIM, runs, opts(repo)), 'code-reviewer, silent-failure-hunter');
    blocked(runWithResults(CLAIM, [runs[0], dispatchOf('code-reviewer', stamp(2)), runs[1]], opts(repo)), 'silent-failure-hunter');
  });

  await t.test('a code-reviewer pass from an earlier turn keeps a later small edit quiet', () => {
    const repo = scratchRepo();
    const turns = (...earlier) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), ...earlier, { prompt: 'next', timestamp: stamp(3) }, writeOf(repo, 'fix.ts', sourceLines(3), stamp(4)), checked(stamp(5))];
    quiet(runWithResults(CLAIM, turns(dispatchOf('code-reviewer', stamp(2))), opts(repo)));
    blocked(runWithResults(CLAIM, turns(), opts(repo)), 'code-reviewer');
  });

  await t.test('a turn with no edit that asks to commit or commits is blocked; a claim word alone is not', () => {
    const repo = scratchRepo();
    const turns = (...tail) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, ...tail];
    blocked(runWithResults(ASK, turns(), opts(repo)), 'code-reviewer');
    blocked(runWithResults('Committed as abc1234.', turns(committed(stamp(4))), opts(repo)), 'code-reviewer');
    const reviewed = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(2)), { prompt: 'next', timestamp: stamp(3) }];
    quiet(runWithResults(ASK, reviewed, opts(repo)));
    quiet(runWithResults('The test passes because the cutoff sorts first.', turns(), opts(repo)));
  });

  await t.test('a code turn that asks to commit or commits is blocked the same way', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    blocked(runWithResults(ASK, [thirty, checked(stamp(3))], opts(repo)), 'code-reviewer');
    blocked(runWithResults('Committed as abc1234.', [thirty, checked(stamp(3)), committed(stamp(4))], opts(repo)), 'code-reviewer');
  });

  await t.test('a 3-line Write and a claim owe nothing', () => {
    const repo = scratchRepo();
    quiet(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(3), stamp(1)), checked(stamp(3))], opts(repo)));
  });

  await t.test('a first line opening "Step N" owes no required member and keeps the lens check', () => {
    const repo = scratchRepo();
    fs.writeFileSync(path.join(repo, 'impl.ts'), sourceLines(30, withCatch));
    const res = runWithResults('Step 2 passes verify.', [writeOf(repo, 'impl.ts', sourceLines(30, withCatch), stamp(1)), checked(stamp(2))], opts(repo));
    assert.doesNotMatch(res.stderr, NOT_RUN);
    assert.match(res.stderr, /REVIEW NOT RUN for silent-failure-hunter/);
  });

  await t.test('a window opened by a delivered REPORT owes no required member; a typed prompt in its place does', () => {
    const repo = scratchRepo();
    const afterOpener = (opener) => runWithResults('Committed as abc1234.', [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), opener, committed(stamp(4))], opts(repo));
    quiet(afterOpener({ sent: `[REPORT demo step 1] Step 1 built.\n${RAW_OUTPUT}`, output: 'Message sent to planner-1', timestamp: stamp(2) }));
    blocked(afterOpener({ prompt: 'next', timestamp: stamp(2) }), 'code-reviewer');
  });

  await t.test('an implementer hand-back whose agent transcript wrote 30 lines is blocked on a claim', () => {
    const repo = scratchRepo();
    const reply = `Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}`;
    const runs = [{ handback: handBack('implementer') }, { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' }];
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    const agentDir = path.join(tmpDir, path.basename(transcriptPath, '.jsonl'), 'subagents');
    fs.mkdirSync(agentDir, { recursive: true });
    const agentWrite = { type: 'assistant', timestamp: stamp(1), message: { content: [{ type: 'tool_use', id: 'agent-write', name: 'Write', input: { file_path: path.join(repo, 'impl.ts'), content: sourceLines(30) } }] } };
    fs.writeFileSync(path.join(agentDir, 'agent-a1b2c3.jsonl'), JSON.stringify(agentWrite));
    blocked(runWithResults(reply, runs, opts(repo, { transcriptPath })), 'code-reviewer');
    quiet(runWithResults(reply, runs, opts(repo)));
  });

  const workerEdit = (repo, file) => {
    const out = path.join(tmpDir, `wk${nextSeq()}.output`);
    const id = path.basename(out, '.output');
    fs.writeFileSync(out, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, file) } }] } }));
    const hb = handBack('implementer');
    hb.origin.from = id;
    return {
      dispatch: { blocks: [{ type: 'tool_use', id: `dispatch-${id}`, name: 'Agent', input: { subagent_type: 'implementer' } }], timestamp: stamp(2) },
      result: { record: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `dispatch-${id}`, content: `Async agent launched.\noutput_file: ${out}` }] } } },
      handback: { handback: hb },
    };
  };
  const workerReply = `Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}`;

  await t.test('a worker edit to code after a code-reviewer dispatch re-owes it', () => {
    const repo = scratchRepo();
    const worker = workerEdit(repo, 'more.ts');
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), worker.dispatch, worker.result, dispatchOf('code-reviewer', stamp(3)), worker.handback, checked(stamp(4))];
    blocked(runWithResults(workerReply, runs, opts(repo)), 'code-reviewer');
  });

  await t.test('a worker edit to code before the code-reviewer dispatch leaves it quiet', () => {
    const repo = scratchRepo();
    const worker = workerEdit(repo, 'more.ts');
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), worker.dispatch, worker.result, worker.handback, dispatchOf('code-reviewer', stamp(3)), checked(stamp(4))];
    quiet(runWithResults(workerReply, runs, opts(repo)));
  });

  await t.test('a worker edit to a non-code file after the code-reviewer dispatch leaves it quiet', () => {
    const repo = scratchRepo();
    const worker = workerEdit(repo, 'notes.md');
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), worker.dispatch, worker.result, dispatchOf('code-reviewer', stamp(3)), worker.handback, checked(stamp(4))];
    quiet(runWithResults(workerReply, runs, opts(repo)));
  });

  await t.test('the retry blocks once more while a member is still missing', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const retry = (...runs) => runWithResults('Findings are below.', runs, opts(repo, { stopHookActive: true }));
    blocked(retry(written, agentFeedback()), 'code-reviewer');
    quiet(retry(written, agentFeedback(), dispatchOf('code-reviewer', stamp(3))));
    quiet(retry(written, agentFeedback(), agentFeedback()));
    quiet(retry(written, feedbackOf('REVIEW NOT RUN for reuse-analyzer: this turn edited code and claims done.')));
  });

  await t.test('a third block is not added once two such blocks are in the window', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), agentFeedback(), agentFeedback(), checked(stamp(3))];
    quiet(runWithResults(CLAIM, runs, opts(repo)));
  });

  await t.test('once two such blocks are in the window, a signalled lens still needs its own pass', () => {
    const repo = scratchRepo();
    fs.writeFileSync(path.join(repo, 'impl.ts'), sourceLines(30, withCatch));
    const res = runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(30, withCatch), stamp(1)), agentFeedback(), agentFeedback(), checked(stamp(3))], opts(repo));
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /REVIEW NOT RUN for silent-failure-hunter:/);
    assert.doesNotMatch(res.stderr, NOT_RUN);
  });

  await t.test('after two blocks a Big member in owed-files still blocks a claim, on the retry too; a reply that claims nothing is released', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(200), stamp(1));
    const twoBlocks = [written, agentFeedback(), agentFeedback()];
    const retry = (reply, ...runs) => runWithResults(reply, runs, opts(repo, { stopHookActive: true }));
    const bigOnly = BIG_MEMBERS.join(', ');
    blocked(runWithResults(CLAIM, [...twoBlocks, checked(stamp(3))], opts(repo)), bigOnly);
    blocked(retry('The branch is ready to merge.', ...twoBlocks), bigOnly);
    blocked(retry('Committed as abc1234.', ...twoBlocks, committed(stamp(4))), bigOnly);
    quiet(retry('Findings are below.', ...twoBlocks));
    quiet(retry('The branch is ready to merge.', ...twoBlocks.slice(0, 1), dispatchOf('code-reviewer', stamp(2)), ...bigDispatches(stamp(2)), agentFeedback(), agentFeedback()));
  });

  await t.test('after two blocks a grep naming git commit is no commit; a commit, landed or errored, still holds the Big members', () => {
    const repo = scratchRepo();
    const twoBlocks = [writeOf(repo, 'impl.ts', sourceLines(250), stamp(1)), agentFeedback(), agentFeedback(), checked(stamp(3))];
    const reply = 'Findings are below.';
    const grep = { command: 'grep -n "git commit" x.sh', output: 'x.sh:1', timestamp: stamp(4) };
    const failedCommit = { ...committed(stamp(4)), isError: true, output: 'Exit code 1' };
    for (const stopHookActive of [true, false]) {
      quiet(runWithResults(reply, [...twoBlocks, grep], opts(repo, { stopHookActive })));
      blocked(runWithResults(reply, [...twoBlocks, failedCommit], opts(repo, { stopHookActive })), BIG_MEMBERS.join(', '));
      blocked(runWithResults(reply, [...twoBlocks, committed(stamp(4))], opts(repo, { stopHookActive })), BIG_MEMBERS.join(', '));
    }
  });

  await t.test('after two blocks a last-line commit ask holds the Big members; the same reply without the ask is released', () => {
    const repo = scratchRepo();
    const twoBlocks = [writeOf(repo, 'impl.ts', sourceLines(250), stamp(1)), agentFeedback(), agentFeedback()];
    for (const stopHookActive of [true, false]) {
      blocked(runWithResults(ASK, twoBlocks, opts(repo, { stopHookActive })), BIG_MEMBERS.join(', '));
      quiet(runWithResults('Diff is above.', twoBlocks, opts(repo, { stopHookActive })));
    }
  });

  await t.test('after two blocks a commit owing only code-reviewer and a signalled member is released', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30, withCatch), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, agentFeedback(), agentFeedback(), committed(stamp(4))];
    quiet(runWithResults('Committed as abc1234.', runs, opts(repo)));
    blocked(runWithResults('Committed as abc1234.', runs.filter((run) => run !== runs[3]), opts(repo)), 'code-reviewer, silent-failure-hunter');
  });

  await t.test('a first line opening "Step N" stays exempt from the Big members, on the first run and the retry', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(250), stamp(1)), checked(stamp(3))];
    quiet(runWithResults('Step 2 passes verify.', runs, opts(repo)));
    quiet(runWithResults('Step 2 passes verify.', runs, opts(repo, { stopHookActive: true })));
  });

  await t.test('a dispatch with an errored result does not clear a signalled lens', () => {
    const repo = scratchRepo();
    fs.writeFileSync(path.join(repo, 'api.ts'), 'p.catch(() => null);');
    const hunter = { blocks: [{ type: 'tool_use', id: 'hunter', name: 'Agent', input: { subagent_type: 'pr-review-toolkit:silent-failure-hunter' } }] };
    const res = runWithResults(ASK, [hunter, resultOf('hunter', true)], { cwd: repo });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /REVIEW NOT RUN for silent-failure-hunter:/);
    assert.equal(runWithResults(ASK, [hunter, resultOf('hunter', false)], { cwd: repo }).status, 0);
  });

  await t.test('a retry after an unrelated block checks a reply that commits; a plain reply passes', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const unrelated = feedbackOf('DONE-CLAIM WITHOUT EVIDENCE: the first line claims \'done\' but no test or runtime command ran this turn.');
    const retry = (...runs) => runWithResults('Findings are below.', runs, opts(repo, { stopHookActive: true }));
    blocked(retry(written, unrelated, committed(stamp(3))), 'code-reviewer');
    quiet(retry(written, unrelated, checked(stamp(3))));
  });

  await t.test('a dispatch before the last write does not clear a member; one after it does', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(2));
    blocked(runWithResults(CLAIM, [dispatchOf('code-reviewer', stamp(1)), thirty, checked(stamp(3))], opts(repo)), 'code-reviewer');
    quiet(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo)));
  });

  await t.test('a "Step N" first line that also commits is checked for required members', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    blocked(runWithResults('Step 1 built and committed.', [thirty, checked(stamp(3)), committed(stamp(4))], opts(repo)), 'code-reviewer');
    quiet(runWithResults('Step 1 is done.', [thirty, checked(stamp(3))], opts(repo)));
  });

  await t.test('a "Step N" claim stays exempt on the retry; one that commits, asks to commit or follows an agent block is checked there', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const retry = (reply, ...runs) => runWithResults(reply, runs, opts(repo, { stopHookActive: true }));
    quiet(retry('Step 1 is done.', thirty, checked(stamp(3))));
    blocked(retry('Step 1 built and committed.', thirty, checked(stamp(3)), committed(stamp(4))), 'code-reviewer');
    blocked(retry('Step 1 done.\nSay yes and I will commit.', thirty, checked(stamp(3))), 'code-reviewer');
    blocked(retry('Step 1 is done.', thirty, checked(stamp(3)), agentFeedback()), 'code-reviewer');
  });

  await t.test('a file name holding " required=none" does not empty the required list', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'src/auth/x required=none y.ts', sourceLines(30), stamp(1)), checked(stamp(3))];
    blocked(runWithResults(CLAIM, runs, opts(repo)), ['code-reviewer', ...BIG_MEMBERS].join(', '));
  });

  await t.test('a later claim turn that only ran an agent is blocked for the Big members; quiet once the earlier turn ran code-reviewer and all seven', () => {
    const repo = scratchRepo();
    const later = (...earlier) => [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), ...earlier, { prompt: 'next', timestamp: stamp(3) }, dispatchOf('Explore', stamp(4))];
    blocked(runWithResults(CLAIM, later(dispatchOf('code-reviewer', stamp(2))), opts(repo)), BIG_MEMBERS.join(', '));
    quiet(runWithResults(CLAIM, later(dispatchOf('code-reviewer', stamp(2)), ...bigDispatches(stamp(2))), opts(repo)));
  });

  await t.test('a turn with no edit is not blocked by a question about a past commit, a grep naming one, or "commitment"', () => {
    const repo = scratchRepo();
    const turns = (...tail) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, ...tail];
    quiet(runWithResults('It touched two files.\nWant me to walk through that commit line by line?', turns(), opts(repo)));
    quiet(runWithResults('Three hooks match it: a, b and c.', turns({ command: 'grep -rn "git commit" hooks/', output: 'hooks/a.sh', timestamp: stamp(4) }), opts(repo)));
    quiet(runWithResults('It is stable.\nDo you want me to check the team\'s commitment on v2?', turns(), opts(repo)));
    blocked(runWithResults('Committed as abc1234.', turns({ command: 'git add -A && git commit -m x', output: '', timestamp: stamp(4) }), opts(repo)), 'code-reviewer');
  });

  const COMMITTED = 'Committed as abc1234.';
  const noCodeTurn = (repo, ...tail) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, ...tail];

  await t.test('a commit inside a subshell counts; a grep naming git commit in the same position does not', () => {
    const repo = scratchRepo();
    const at = (command) => runWithResults(COMMITTED, noCodeTurn(repo, { command, output: '', timestamp: stamp(4) }), opts(repo));
    blocked(at('( git commit -m x )'), 'code-reviewer');
    quiet(at('( grep -n "git commit" f )'));
    quiet(at('grep -n "git commit" f'));
  });

  await t.test('a commit that errored still counts, since `-q` prints no sha line; an errored grep naming it does not', () => {
    const repo = scratchRepo();
    const errored = (command) => runWithResults(COMMITTED, noCodeTurn(repo, { command, isError: true, output: 'Exit code 1', timestamp: stamp(4) }), opts(repo));
    blocked(errored('git commit -qm x && false'), 'code-reviewer');
    quiet(errored('grep -n "git commit" f'));
  });

  const codeTurn = (repo, command) => runWithResults('Findings are below.', [{ command, output: 'f:1', timestamp: stamp(2) }], { cwd: repo, since: stamp(0), lint: false });

  await t.test('a code turn that only greps for git commit owes no LINT/TSC; the same turn committing does', () => {
    const repo = scratchRepo();
    const grep = codeTurn(repo, 'grep "git commit" f');
    assert.equal(grep.status, 0, grep.stderr);
    assert.doesNotMatch(grep.stderr, /LINT\/TSC NOT RUN/);
    const commit = codeTurn(repo, 'git commit -m x');
    assert.equal(commit.status, 2, commit.stderr);
    assert.match(commit.stderr, /LINT\/TSC NOT RUN: this turn edited web code and ran git commit/);
  });

  await t.test('a commit behind a wrapper, prefix, path or shell opener counts on a code turn; text that names the wrapper does not', () => {
    const repo = scratchRepo();
    const shapes = [
      'exec git commit -q --amend -F m',
      'printf x | xargs -0 git commit -q',
      'env GIT_AUTHOR_NAME=x git commit -m x',
      'GIT_AUTHOR_NAME="A B" git commit -m x',
      'X="$(git log -1 --format=%an)" git commit-tree t -p HEAD -m x',
      'timeout 60 git commit -m x',
      '/usr/bin/git commit -m x',
      'zsh -c "git commit -m x"',
      'bash -lc "git commit -m x"',
      'if git commit -m x; then :; fi',
    ];
    for (const command of shapes) {
      const res = codeTurn(repo, command);
      assert.equal(res.status, 2, `${command}\n${res.stderr}`);
      assert.match(res.stderr, /LINT\/TSC NOT RUN/, command);
    }
    for (const command of ['echo "exec git commit"', 'grep -rn "xargs git commit" f']) {
      const res = codeTurn(repo, command);
      assert.equal(res.status, 0, `${command}\n${res.stderr}`);
    }
  });

  await t.test('a 20,000-character command of assignments and spaces with no commit runs the gate in under 2 seconds', () => {
    const repo = scratchRepo();
    const started = Date.now();
    const res = codeTurn(repo, 'x=1  '.repeat(4000));
    assert.equal(res.status, 0, res.stderr);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  await t.test('a "Step N" first line over an errored commit is checked like a landed one, on the first run and the retry; over a grep naming it, it stays exempt', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const failedCommit = { ...committed(stamp(4)), isError: true, output: 'Exit code 1' };
    const grep = { command: 'grep "git commit" f', output: 'f:1', timestamp: stamp(4) };
    for (const stopHookActive of [false, true]) {
      const step = (run) => runWithResults('Step 2 done.', [thirty, checked(stamp(3)), run], opts(repo, { stopHookActive }));
      blocked(step(failedCommit), 'code-reviewer');
      blocked(step(committed(stamp(4))), 'code-reviewer');
      quiet(step(grep));
    }
  });

  await t.test('a commit inside `bash -c` counts; an echo naming it does not', () => {
    const repo = scratchRepo();
    const at = (command) => runWithResults(COMMITTED, noCodeTurn(repo, { command, output: '', timestamp: stamp(4) }), opts(repo));
    blocked(at('bash -c "git commit -m x"'), 'code-reviewer');
    quiet(at('echo "git commit -m x"'));
  });

  await t.test('an agent that wrote 30 lines makes a plan-only turn owe code-reviewer on a claim; 3 lines owe nothing', () => {
    const repo = scratchRepo();
    const agentWrote = (lineCount) => {
      const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
      const agentDir = path.join(tmpDir, path.basename(transcriptPath, '.jsonl'), 'subagents');
      fs.mkdirSync(agentDir, { recursive: true });
      const write = { type: 'assistant', timestamp: stamp(2), message: { content: [{ type: 'tool_use', id: 'agent-write', name: 'Write', input: { file_path: path.join(repo, 'impl.ts'), content: sourceLines(lineCount) } }] } };
      fs.writeFileSync(path.join(agentDir, 'agent-a1b2c3.jsonl'), JSON.stringify(write));
      return transcriptPath;
    };
    const planEdit = path.join(repo, 'docs', 'plans', 'p.md');
    const runs = [dispatchOf('general-purpose', stamp(1)), checked(stamp(3))];
    blocked(runWithResults(CLAIM, runs, opts(repo, { editedFile: planEdit, transcriptPath: agentWrote(30) })), 'code-reviewer');
    quiet(runWithResults(CLAIM, runs, opts(repo, { editedFile: planEdit, transcriptPath: agentWrote(3) })));
  });

  await t.test('empty stdin, or a retry with no transcript, exits 0', () => {
    for (const input of ['', JSON.stringify({ stop_hook_active: true })]) {
      assert.equal(spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8' }).status, 0, input);
    }
  });
});
