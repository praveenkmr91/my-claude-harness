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
  const review = (subagent_type, prompt) => ({ type: 'tool_use', name: 'Agent', input: { subagent_type, prompt } });
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

  await t.test('blocks when the plan was edited after its last review, quiet once a cold read follows the edit', () => {
    const blocks = [writePlan(), review('dry-runner', `Dry-run ${PLAN}`), advisor, editPlan()];
    const fires = runPlan(turn(blocks, asks.typeRepo), asks.typeRepo);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(A\)/);
    assert.doesNotMatch(fires.stderr, /\(B\)/);
    const quiet = runPlan(turn([...blocks, review('cold-reader', PLAN), readPlan(), authorReview], asks.typeRepo), asks.typeRepo);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('blocks a reviewed plan with no advisor after its first review, quiet once the advisor ran', () => {
    const blocks = [writePlan(), review('dry-runner', `Dry-run ${PLAN}`)];
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

  await t.test('tracking spans turns: a review in turn 1 covers an ask in turn 2, a plan edit in turn 2 voids it', () => {
    const turn1 = [prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN), advisor, readPlan(), authorReview), assistant({ type: 'text', text: 'Plan is ready.' })];
    const quiet = runPlan([...turn1, prompt('looks good'), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(quiet.status, 0, quiet.stderr);
    const fires = runPlan([...turn1, prompt('change step 2'), assistant(editPlan()), assistant({ type: 'text', text: asks.type })], asks.type);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(A\)/);
  });

  await t.test('an empty transcript, and a plan reply with no implement ask, pass', () => {
    const empty = runPlan([], asks.type);
    assert.equal(empty.status, 0, empty.stderr);
    const noAsk = runPlan(turn([writePlan()], 'The plan is written to x.md.'), 'The plan is written to x.md.');
    assert.equal(noAsk.status, 0, noAsk.stderr);
  });

  await t.test('a Fable thread\'s plan ask needs no advisor consult', () => {
    const records = [...onModel('claude-fable-5-2', turn([writePlan(), review('dry-runner', `Dry-run ${PLAN}`), readPlan(), authorReview], asks.say)), interrupt];
    const quiet = runPlan(records, asks.say);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('a Fable thread\'s plan ask still needs a review after the last edit', () => {
    const records = [...onModel('claude-fable-5-2', turn([writePlan(), review('dry-runner', `Dry-run ${PLAN}`), editPlan()], asks.say)), interrupt];
    const fires = runPlan(records, asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(A\)/);
    assert.doesNotMatch(fires.stderr, /\(B\)/);
  });

  await t.test('an Opus thread\'s plan ask still needs the advisor consult', () => {
    const fires = runPlan(onModel('claude-opus-5-5', turn([writePlan(), review('dry-runner', `Dry-run ${PLAN}`)], asks.say)), asks.say);
    assert.equal(fires.status, 2, fires.stderr);
    assert.match(fires.stderr, /\(B\)/);
  });

  await t.test('blocks a reviewed plan with no `Pass: review` of its own after the last edit, on every model', () => {
    const blocks = [writePlan(), review('dry-runner', `Dry-run ${PLAN}`), advisor];
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
    const staleRead = runPlan(turn([writePlan(), review('dry-runner', `Dry-run ${PLAN}`), advisor, readPlan(), editPlan(), review('dry-runner', `Dry-run ${PLAN}`), authorReview], asks.type), asks.type);
    assert.equal(staleRead.status, 2, staleRead.stderr);
    assert.match(staleRead.stderr, /\(C\)/);
    assert.doesNotMatch(staleRead.stderr, /\(A\)/);
    assert.doesNotMatch(staleRead.stderr, /\(B\)/);
    const stale =runPlan(turn([writePlan(), authorReview, review('dry-runner', `Dry-run ${PLAN}`), advisor, editPlan(), review('dry-runner', `Dry-run ${PLAN}`)], asks.type), asks.type);
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
    assert.match(fires.stderr, /: source written in this session still owes each an agent run\. Dispatch each member as an agent with an `effort`/);
    quiet(runWithResults(CLAIM, [thirty, dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo)));
    for (const line of ['code-reviewer: 0 findings', 'code-reviewer: skip — reviewed by hand', 'code-reviewer: not run — small change']) {
      blocked(runWithResults(`${CLAIM}\n${line}`, [thirty, checked(stamp(3))], opts(repo)), 'code-reviewer');
    }
  });

  const BIG_MEMBERS = ['silent-failure-hunter', 'type-design-analyzer', 'reuse-analyzer', 'placement-analyzer'];

  await t.test('a claim over 200 unreviewed lines with code-reviewer dispatched is blocked for the four Big members alone', () => {
    const repo = scratchRepo();
    const big = writeOf(repo, 'impl.ts', sourceLines(200), stamp(1));
    const fires = runWithResults(CLAIM, [big, dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo));
    blocked(fires, BIG_MEMBERS.join(', '));
    const message = fires.stderr.split('\n').find((line) => NOT_RUN.test(line));
    assert.doesNotMatch(message, /code-reviewer/);
    assert.match(message, /Give each everything written since its last run, never the last commit alone\.$/);
  });

  await t.test('a claim over 200 lines is quiet once all five members were dispatched after the write', () => {
    const repo = scratchRepo();
    const dispatches = ['code-reviewer', ...BIG_MEMBERS].map((member) => dispatchOf(member, stamp(2)));
    quiet(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), ...dispatches, checked(stamp(3))], opts(repo)));
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
    const dispatches = ['code-reviewer', ...BIG_MEMBERS].filter((member) => member !== without).map((member) => dispatchOf(member, stamp(2)));
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

  await t.test('quiet: the unshown block is not added once two such blocks are in the window', () => {
    const repo = scratchRepo();
    const runs = [...bigRuns(repo, TWO_FILES, { linked: true }), agentFeedback(), agentFeedback()];
    quiet(runWithResults(BULK_CLAIM, runs, opts(repo, { transcriptPath: reviewerShown('a.ts') })));
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

  await t.test('a later typed turn that only commits is blocked for the four when the earlier turn dispatched code-reviewer alone', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), dispatchOf('code-reviewer', stamp(2)), { prompt: 'next', timestamp: stamp(3) }, committed(stamp(5))];
    blocked(runWithResults('Committed as abc1234.', runs, opts(repo)), BIG_MEMBERS.join(', '));
  });

  await t.test('a later typed turn that dispatches the four and commits is quiet', () => {
    const repo = scratchRepo();
    const dispatches = BIG_MEMBERS.map((member) => dispatchOf(member, stamp(4)));
    const runs = [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), dispatchOf('code-reviewer', stamp(2)), { prompt: 'next', timestamp: stamp(3) }, ...dispatches, committed(stamp(5))];
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

  await t.test('a later claim turn that only ran an agent is blocked for the four Big members; quiet once the earlier turn dispatched all five', () => {
    const repo = scratchRepo();
    const later = (...earlier) => [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), ...earlier.map((member) => dispatchOf(member, stamp(2))), { prompt: 'next', timestamp: stamp(3) }, dispatchOf('Explore', stamp(4))];
    blocked(runWithResults(CLAIM, later('code-reviewer'), opts(repo)), BIG_MEMBERS.join(', '));
    quiet(runWithResults(CLAIM, later('code-reviewer', ...BIG_MEMBERS), opts(repo)));
  });

  await t.test('a turn with no edit is not blocked by a question about a past commit, a grep naming one, or "commitment"', () => {
    const repo = scratchRepo();
    const turns = (...tail) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, ...tail];
    quiet(runWithResults('It touched two files.\nWant me to walk through that commit line by line?', turns(), opts(repo)));
    quiet(runWithResults('Three hooks match it: a, b and c.', turns({ command: 'grep -rn "git commit" hooks/', output: 'hooks/a.sh', timestamp: stamp(4) }), opts(repo)));
    quiet(runWithResults('It is stable.\nDo you want me to check the team\'s commitment on v2?', turns(), opts(repo)));
    blocked(runWithResults('Committed as abc1234.', turns({ command: 'git add -A && git commit -m x', output: '', timestamp: stamp(4) }), opts(repo)), 'code-reviewer');
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
