'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  HOOK_PATH, tmpDir, LENS_SKIPS, LEARN_SKIP, RAW_OUTPUT, handBack, env, nextSeq, runFull, runWithResults,
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
  const dispatchOf = (member, timestamp, id = `dispatch-${member}`, answered = true) => ({ blocks: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: member, description: 'review', prompt: 'review', effort: 'low' } }], timestamp, answered });
  const skillOf = (skill, timestamp, id = `skill-${skill}`, answered = true) => ({ blocks: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }], timestamp, answered });
  const resultOf = (id, isError, timestamp, text = 'out') => ({ record: { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } } });
  const checked = (timestamp) => ({ command: 'pnpm lint && node --test tests/*.test.js', output: 'ℹ fail 0', timestamp });
  const committed = (timestamp) => ({ command: 'git commit -m x', output: '', timestamp });
  const shipped = (timestamp) => ({ command: 'git rm docs/plans/demo.md && git commit -m ship', output: '', timestamp });
  const feedbackOf = (text) => ({ record: { type: 'user', isMeta: true, message: { content: `Stop hook feedback:\n[bash …/done-claim-gate.sh]: ${text}` } } });
  const agentFeedback = () => feedbackOf('REVIEW AGENTS NOT RUN for code-reviewer: source written in this session still owes each a run.');
  const opts = (repo, extra) => ({ cwd: repo, since: stamp(0), lint: false, editedFile: null, ...extra });
  const blocked = (res, members) => {
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, new RegExp(`REVIEW AGENTS NOT RUN for ${members}:`));
  };
  const quiet = (res) => {
    assert.doesNotMatch(res.stderr, NOT_RUN);
    assert.equal(res.status, 0, res.stderr);
  };

  const AGENT_MEMBERS = ['code-reviewer', 'silent-failure-hunter', 'type-design-analyzer', 'placement-analyzer', 'adversarial-reviewer'];
  const BIG_MEMBERS = AGENT_MEMBERS.slice(1);
  const ALL_NAMES = AGENT_MEMBERS.join(', ');
  const BIG_NAMES = BIG_MEMBERS.join(', ');
  const allRuns = (timestamp, without) => AGENT_MEMBERS.filter((member) => member !== without).map((member) => dispatchOf(member, timestamp));
  const bigDispatches = (timestamp, without) => BIG_MEMBERS.filter((member) => member !== without).map((member) => dispatchOf(member, timestamp));
  const SIX_NAMES = `${ALL_NAMES}, security-review`;

  await t.test('a claim over 30 unreviewed lines needs code-reviewer dispatched as an agent; typed lines clear nothing', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const fires = runWithResults(CLAIM, [thirty, checked(stamp(3))], opts(repo));
    blocked(fires, 'code-reviewer');
    assert.match(fires.stderr, /: source written in this session still owes each a run\. Run `security-review` as a `Skill` call and the rest as agents, each with an `effort`/);
    quiet(runWithResults(CLAIM, [thirty, dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo)));
    for (const line of ['code-reviewer: 0 findings', 'code-reviewer: skip — reviewed by hand', 'code-reviewer: not run — small change']) {
      blocked(runWithResults(`${CLAIM}\n${line}`, [thirty, checked(stamp(3))], opts(repo)), 'code-reviewer');
    }
    const caught = [writeOf(repo, 'api.ts', sourceLines(30, withCatch), stamp(1)), checked(stamp(3))];
    blocked(runWithResults(`${CLAIM}\nsilent-failure-hunter: 0 findings`, caught, opts(repo)), 'code-reviewer, silent-failure-hunter');
  });

  await t.test('a claim over 200 unreviewed lines with code-reviewer dispatched is blocked for the four Big members alone', () => {
    const repo = scratchRepo();
    const big = writeOf(repo, 'impl.ts', sourceLines(200), stamp(1));
    const fires = runWithResults(CLAIM, [big, dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo));
    blocked(fires, BIG_NAMES);
    const message = fires.stderr.split('\n').find((line) => NOT_RUN.test(line));
    assert.doesNotMatch(message.split(':')[0], /code-reviewer|security-review/);
    assert.match(message, /Give each everything written since its last run, never the last commit alone\.$/);
  });

  await t.test('a claim over 200 lines is quiet once code-reviewer and the four Big members ran after the write', () => {
    const repo = scratchRepo();
    quiet(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), ...allRuns(stamp(2)), checked(stamp(3))], opts(repo)));
  });

  await t.test('a claim over 25 lines in a risk path adds security-review, cleared by a finished main-thread Skill call alone', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'src/useAuth.ts', sourceLines(25), stamp(1));
    const agents = allRuns(stamp(2));
    blocked(runWithResults(CLAIM, [written, checked(stamp(3))], opts(repo)), SIX_NAMES);
    const typedLines = `${CLAIM}\nsecurity-review: 0 findings\nadversarial-reviewer: skip — reviewed by hand`;
    blocked(runWithResults(typedLines, [written, ...agents, checked(stamp(3))], opts(repo)), 'security-review');
    blocked(runWithResults(CLAIM, [written, ...agents, dispatchOf('security-review', stamp(2)), checked(stamp(3))], opts(repo)), 'security-review');
    const typedCommand = { record: { type: 'user', timestamp: stamp(2), message: { content: '<command-name>/security-review</command-name>' } } };
    blocked(runWithResults(CLAIM, [written, ...agents, typedCommand, checked(stamp(3))], opts(repo)), 'security-review');
    quiet(runWithResults(CLAIM, [written, ...agents, skillOf('security-review', stamp(2)), checked(stamp(3))], opts(repo)));
  });

  await t.test('a Skill call before the last write, an errored one and an unfinished one clear nothing', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'src/useAuth.ts', sourceLines(25), stamp(1));
    const agents = allRuns(stamp(2));
    blocked(runWithResults(CLAIM, [skillOf('security-review', stamp(0)), written, ...agents, checked(stamp(3))], opts(repo)), 'security-review');
    const errored = [skillOf('security-review', stamp(2), 'skill-sr', false), resultOf('skill-sr', true, stamp(2))];
    blocked(runWithResults(CLAIM, [written, ...agents, ...errored, checked(stamp(3))], opts(repo)), 'security-review');
    blocked(runWithResults(CLAIM, [written, ...agents, skillOf('security-review', stamp(2), 'skill-sr', false), checked(stamp(3))], opts(repo)), 'security-review');
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
    const dispatches = AGENT_MEMBERS.filter((member) => member !== without).map((member) => dispatchOf(member, stamp(2), undefined, !(linked && member === 'placement-analyzer')));
    const link = linked ? [resultOf('dispatch-placement-analyzer', false, stamp(2), 'done\nagentId: r1 (use SendMessage to continue)')] : [];
    return [...writes, ...dispatches, ...link, checked(stamp(3))];
  };
  const TWO_FILES = [['a.ts', 200], ['b.ts', 200]];

  await t.test('a Big member whose linked run was shown only some of the files is blocked, with the unshown file named', () => {
    const repo = scratchRepo();
    const fires = runWithResults(CLAIM, bigRuns(repo, TWO_FILES, { linked: true }), opts(repo, { transcriptPath: reviewerShown('a.ts') }));
    blocked(fires, 'placement-analyzer');
    assert.ok(fires.stderr.split('\n').includes('placement-analyzer has not been shown: b.ts.'), fires.stderr);
  });

  await t.test('quiet: the same run shown both files', () => {
    const repo = scratchRepo();
    quiet(runWithResults(CLAIM, bigRuns(repo, TWO_FILES, { linked: true }), opts(repo, { transcriptPath: reviewerShown('a.ts', 'b.ts') })));
  });

  await t.test('the unshown block still holds once two such blocks are in the window; a run shown both files is quiet', () => {
    const repo = scratchRepo();
    const runs = [...bigRuns(repo, TWO_FILES, { linked: true }), agentFeedback(), agentFeedback()];
    const fires = runWithResults(CLAIM, runs, opts(repo, { transcriptPath: reviewerShown('a.ts') }));
    blocked(fires, 'placement-analyzer');
    assert.ok(fires.stderr.split('\n').includes('placement-analyzer has not been shown: b.ts.'), fires.stderr);
    quiet(runWithResults(CLAIM, runs, opts(repo, { transcriptPath: reviewerShown('a.ts', 'b.ts') })));
  });

  await t.test('a Big member with no dispatch in the turn is named with its files', () => {
    const repo = scratchRepo();
    const fires = runWithResults(CLAIM, bigRuns(repo, TWO_FILES, { without: 'type-design-analyzer' }), opts(repo));
    blocked(fires, 'type-design-analyzer');
    assert.ok(fires.stderr.split('\n').includes('type-design-analyzer has not been shown: a.ts, b.ts.'), fires.stderr);
  });

  await t.test('seven unshown files: five are named, decoded, and the rest counted', () => {
    const repo = scratchRepo();
    const files = [['my file.ts', 220], ...[1, 2, 3, 4, 5, 6].map((n) => [`f${n}.ts`, 200])];
    const fires = runWithResults(CLAIM, bigRuns(repo, files, { without: 'placement-analyzer' }), opts(repo));
    blocked(fires, 'placement-analyzer');
    assert.ok(fires.stderr.split('\n').includes('placement-analyzer has not been shown: my file.ts, f1.ts, f2.ts, f3.ts, f4.ts and 2 more.'), fires.stderr);
  });

  await t.test('a typed turn that only commits owes no review over Big writes that only code-reviewer covered; the same turn claiming done does', () => {
    const repo = scratchRepo();
    const earlier = [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), dispatchOf('code-reviewer', stamp(2)), { prompt: 'next', timestamp: stamp(3) }];
    quiet(runWithResults('Committed as abc1234.', [...earlier, committed(stamp(5))], opts(repo)));
    blocked(runWithResults(CLAIM, [...earlier, checked(stamp(4)), committed(stamp(5))], opts(repo)), BIG_NAMES);
    quiet(runWithResults(CLAIM, [...earlier, ...bigDispatches(stamp(4)), checked(stamp(4)), committed(stamp(5))], opts(repo)));
  });

  await t.test('a commit turn with 300 uncovered lines and no claim owes no review, but the lint check still fires', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(300), stamp(1));
    const unlinted = runWithResults('Committed as abc1234.', [written, committed(stamp(4))], opts(repo));
    assert.equal(unlinted.status, 2, unlinted.stderr);
    assert.match(unlinted.stderr, /LINT\/TSC NOT RUN: this turn edited web code and ran git commit/);
    assert.doesNotMatch(unlinted.stderr, NOT_RUN);
    quiet(runWithResults('Committed as abc1234.', [written, checked(stamp(3)), committed(stamp(4))], opts(repo)));
  });

  const landed = (timestamp) => ({ ...committed(timestamp), output: '[master abc1234] x' });

  await t.test('"Step 3 done." with a plain commit over 300 uncovered lines owes no review; with the shipping commit it names every owed member', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(300), stamp(1));
    quiet(runWithResults('Step 3 done.', [written, checked(stamp(3)), landed(stamp(4))], opts(repo)));
    blocked(runWithResults('Step 3 done.', [written, checked(stamp(3)), shipped(stamp(4))], opts(repo)), ALL_NAMES);
    quiet(runWithResults(`Step 3 done.\n${LEARN_SKIP}`, [written, ...allRuns(stamp(2)), checked(stamp(3)), shipped(stamp(4))], opts(repo)));
  });

  await t.test('only a commit this turn printed is read: "Step 3 done." ships when that commit deleted a plan file, and stays exempt over a HEAD that shipped earlier', () => {
    const identity = { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const repo = scratchRepo();
    fs.mkdirSync(path.join(repo, 'docs/plans'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs/plans/demo.md'), 'plan\n');
    spawnSync('bash', ['-c', 'git add . && git commit -qm seed'], { cwd: repo, env: identity });
    const shippedEarlier = spawnSync('bash', ['-c', 'cd docs/plans && git rm -q demo.md && cd ../.. && git commit -m ship'], { cwd: repo, env: identity, encoding: 'utf8' });
    assert.equal(shippedEarlier.status, 0, shippedEarlier.stderr);
    const written = writeOf(repo, 'impl.ts', sourceLines(300), stamp(1));
    const printed = { command: 'cd docs/plans && git rm -q demo.md && cd ../.. && git commit -m ship', output: shippedEarlier.stdout, timestamp: stamp(4) };
    blocked(runWithResults(`Step 3 done.\n${LEARN_SKIP}`, [written, checked(stamp(3)), printed], opts(repo)), ALL_NAMES);
    const quietLater = { command: 'git commit -qm wip', output: '', timestamp: stamp(4) };
    quiet(runWithResults('Step 3 done.', [written, checked(stamp(3)), quietLater], opts(repo)));
    const erroredLater = { ...quietLater, isError: true };
    quiet(runWithResults('Step 3 done.', [written, checked(stamp(3)), erroredLater], opts(repo)));
  });

  await t.test('the shipping commit over uncovered code is a checkpoint with no claim; runs after the write clear it', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(300), stamp(1));
    const reply = `Shipped.\n${LEARN_SKIP}`;
    blocked(runWithResults(reply, [written, checked(stamp(3)), shipped(stamp(4))], opts(repo)), ALL_NAMES);
    quiet(runWithResults(reply, [written, ...allRuns(stamp(2)), checked(stamp(3)), shipped(stamp(4))], opts(repo)));
  });

  await t.test('a commit that deleted a plan file ships whatever command removed it; a plain commit does not', () => {
    const identity = { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const committedBy = (command) => {
      const repo = scratchRepo();
      fs.mkdirSync(path.join(repo, 'docs/plans'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'docs/done'));
      fs.writeFileSync(path.join(repo, 'docs/plans/demo.md'), 'plan\n');
      fs.writeFileSync(path.join(repo, 'README'), 'x\n');
      spawnSync('bash', ['-c', 'git add . && git commit -qm seed'], { cwd: repo, env: identity });
      const out = spawnSync('bash', ['-c', command], { cwd: repo, env: identity, encoding: 'utf8' });
      assert.equal(out.status, 0, out.stderr);
      return { repo, step: { command, output: out.stdout, timestamp: stamp(4) } };
    };
    const reply = `Shipped.\n${LEARN_SKIP}`;
    const ships = [
      'cd docs/plans && git rm demo.md && cd ../.. && git commit -m ship',
      'P=docs/plans/demo.md; git rm "$P" && git commit -m ship',
      'git mv docs/plans/demo.md docs/done/demo.md && git commit -m ship',
    ];
    for (const command of ships) {
      const { repo, step } = committedBy(command);
      blocked(runWithResults(reply, [writeOf(repo, 'impl.ts', sourceLines(300), stamp(1)), checked(stamp(3)), step], opts(repo)), ALL_NAMES);
    }
    // A sha the cwd repo cannot resolve (a commit made with `git -C <elsewhere>`) must not hide the one that deleted the plan.
    const withForeign = committedBy(ships[0]);
    withForeign.step.output = `[main deadbee] elsewhere\n${withForeign.step.output}`;
    blocked(runWithResults(reply, [writeOf(withForeign.repo, 'impl.ts', sourceLines(300), stamp(1)), checked(stamp(3)), withForeign.step], opts(withForeign.repo)), ALL_NAMES);
    const { repo, step } = committedBy('echo y >> README && git add README && git commit -m tweak');
    quiet(runWithResults(reply, [writeOf(repo, 'impl.ts', sourceLines(300), stamp(1)), checked(stamp(3)), step], opts(repo)));
  });

  await t.test('a dispatch with an errored result, or no result yet, leaves its member in the block', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(2), 'review', false), resultOf('review', true, stamp(2)), checked(stamp(3))];
    blocked(runWithResults(CLAIM, runs, opts(repo)), 'code-reviewer');
    blocked(runWithResults(CLAIM, [runs[0], runs[1], runs[3]], opts(repo)), 'code-reviewer');
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

  await t.test('the gate reads required= by its last match, as owed-files= already is', () => {
    const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
    fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
    const stubJoins = (...required) => `import sys\nprint("<review-joins verb=review lenses=reuse-analyzer ${required.map((r) => `code-added=1 required=${r}`).join(' ')} added=1>")\n`;
    const run = (...required) => {
      fs.writeFileSync(path.join(home, '.claude', 'hooks', 'review-classify.py'), stubJoins(...required));
      const repo = scratchRepo();
      return runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), checked(stamp(3))], opts(repo, { home }));
    };
    blocked(run('none', 'code-reviewer'), 'code-reviewer');
    quiet(run('code-reviewer', 'none'));
  });

  await t.test('a classifier line without required= and with stderr warns once and blocks nothing; one with required=none and stderr stays silent', () => {
    const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
    fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
    const run = (joins) => {
      fs.writeFileSync(path.join(home, '.claude', 'hooks', 'review-classify.py'), `import sys\nprint("${joins}")\nprint("review-classify scan failed: boom", file=sys.stderr)\n`);
      const repo = scratchRepo();
      return runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), checked(stamp(3))], opts(repo, { home }));
    };
    const skipped = run('<review-joins verb=review lenses=reuse-analyzer code-added=0 added=30>');
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.deepEqual(JSON.parse(skipped.stdout), { systemMessage: 'review-classify failed: review-classify scan failed: boom' });
    assert.equal(run('<review-joins verb=review lenses=reuse-analyzer code-added=0 required=none added=30>').stdout, '');
  });

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

  await t.test('a turn with no edit that asks to commit or commits owes no review; "passes", outside a no-code turn\'s claim words, is no claim', () => {
    const repo = scratchRepo();
    const turns = (...tail) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, ...tail];
    quiet(runWithResults(ASK, turns(), opts(repo)));
    quiet(runWithResults('Committed as abc1234.', turns(committed(stamp(4))), opts(repo)));
    quiet(runWithResults('The test passes because the cutoff sorts first.', turns(), opts(repo)));
  });

  await t.test('a code turn that asks to commit or commits owes no review; its done claim does', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    quiet(runWithResults(ASK, [thirty, checked(stamp(3))], opts(repo)));
    quiet(runWithResults('Committed as abc1234.', [thirty, checked(stamp(3)), committed(stamp(4))], opts(repo)));
    blocked(runWithResults(CLAIM, [thirty, checked(stamp(3)), committed(stamp(4))], opts(repo)), 'code-reviewer');
  });

  await t.test('a 3-line Write and a claim owe nothing', () => {
    const repo = scratchRepo();
    quiet(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(3), stamp(1)), checked(stamp(3))], opts(repo)));
  });

  await t.test('a window opened by a delivered REPORT owes only the Big members, which 30 lines do not reach; a typed prompt in its place owes code-reviewer', () => {
    const repo = scratchRepo();
    const afterOpener = (opener) => runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), opener], opts(repo));
    quiet(afterOpener({ sent: `[REPORT demo step 1] Step 1 built.\n${RAW_OUTPUT}`, output: 'Message sent to planner-1', timestamp: stamp(2) }));
    blocked(afterOpener({ prompt: 'next', timestamp: stamp(2) }), 'code-reviewer');
  });

  const withWorker = (repo, ...writes) => {
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    const agentDir = path.join(tmpDir, path.basename(transcriptPath, '.jsonl'), 'subagents');
    fs.mkdirSync(agentDir, { recursive: true });
    const records = writes.map(([file, count, timestamp], i) => JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: `agent-write-${i}`, name: 'Write', input: { file_path: path.join(repo, file), content: sourceLines(count) } }] } }));
    fs.writeFileSync(path.join(agentDir, 'agent-a1b2c3.jsonl'), records.join('\n'));
    return transcriptPath;
  };

  await t.test('an implementer hand-back whose agent transcript wrote 30 lines is blocked on a claim', () => {
    const repo = scratchRepo();
    const reply = `Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}`;
    const runs = [{ handback: handBack('implementer') }, { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' }];
    blocked(runWithResults(reply, runs, opts(repo, { transcriptPath: withWorker(repo, ['impl.ts', 30, stamp(1)]) })), 'code-reviewer');
    quiet(runWithResults(reply, runs, opts(repo)));
  });

  await t.test('a worker write to code after a code-reviewer run re-owes it', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(3)), checked(stamp(5))];
    blocked(runWithResults(CLAIM, runs, opts(repo, { transcriptPath: withWorker(repo, ['more.ts', 30, stamp(4)]) })), 'code-reviewer');
  });

  await t.test('a worker write to code before the code-reviewer run leaves it quiet', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(3)), checked(stamp(5))];
    quiet(runWithResults(CLAIM, runs, opts(repo, { transcriptPath: withWorker(repo, ['more.ts', 30, stamp(2)]) })));
  });

  await t.test('a worker write to a non-code file after the code-reviewer run leaves it quiet', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(3)), checked(stamp(5))];
    quiet(runWithResults(CLAIM, runs, opts(repo, { transcriptPath: withWorker(repo, ['notes.md', 30, stamp(4)]) })));
  });

  await t.test('the retry blocks a claim again while a member is still missing, however many blocks came before; a reply that claims nothing passes', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const retry = (reply, ...runs) => runWithResults(reply, runs, opts(repo, { stopHookActive: true }));
    blocked(retry(CLAIM, written, agentFeedback()), 'code-reviewer');
    blocked(retry(CLAIM, written, agentFeedback(), agentFeedback()), 'code-reviewer');
    quiet(retry(CLAIM, written, agentFeedback(), dispatchOf('code-reviewer', stamp(3))));
    quiet(retry('Findings are below.', written, agentFeedback()));
    quiet(retry('Findings are below.', written, agentFeedback(), agentFeedback()));
    quiet(retry(CLAIM, written, feedbackOf('REVIEW NOT RUN for reuse-analyzer: this turn edited code and claims done.'), dispatchOf('code-reviewer', stamp(3))));
  });

  await t.test('repeated blocks in the window never release a claim: it is blocked while a member is owed, a signalled member included', () => {
    const repo = scratchRepo();
    const twoBlocks = (content) => [writeOf(repo, 'impl.ts', content, stamp(1)), agentFeedback(), agentFeedback(), checked(stamp(3))];
    blocked(runWithResults(CLAIM, twoBlocks(sourceLines(30)), opts(repo)), 'code-reviewer');
    blocked(runWithResults(CLAIM, twoBlocks(sourceLines(30, withCatch)), opts(repo)), 'code-reviewer, silent-failure-hunter');
  });

  await t.test('a claim over 200 uncleared lines holds every Big member however many blocks came before, on the retry too; a commit or a reply that claims nothing passes', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(200), stamp(1));
    const twoBlocks = [written, agentFeedback(), agentFeedback()];
    const retry = (reply, ...runs) => runWithResults(reply, runs, opts(repo, { stopHookActive: true }));
    blocked(runWithResults(CLAIM, [...twoBlocks, checked(stamp(3))], opts(repo)), ALL_NAMES);
    blocked(retry('The branch is ready to merge.', ...twoBlocks), ALL_NAMES);
    quiet(retry('Committed as abc1234.', ...twoBlocks, committed(stamp(4))));
    quiet(retry('Findings are below.', ...twoBlocks));
    quiet(retry('The branch is ready to merge.', written, ...allRuns(stamp(2)), agentFeedback(), agentFeedback()));
  });

  await t.test('however many blocks came before, no commit shape owes a review: a grep, an errored commit and a landed one pass; a claim over them is blocked', () => {
    const repo = scratchRepo();
    const twoBlocks = [writeOf(repo, 'impl.ts', sourceLines(250), stamp(1)), agentFeedback(), agentFeedback(), checked(stamp(3))];
    const grep = { command: 'grep -n "git commit" x.sh', output: 'x.sh:1', timestamp: stamp(4) };
    const failedCommit = { ...committed(stamp(4)), isError: true, output: 'Exit code 1' };
    for (const stopHookActive of [true, false]) {
      quiet(runWithResults('Findings are below.', [...twoBlocks, grep], opts(repo, { stopHookActive })));
      quiet(runWithResults('Findings are below.', [...twoBlocks, failedCommit], opts(repo, { stopHookActive })));
      quiet(runWithResults('Findings are below.', [...twoBlocks, committed(stamp(4))], opts(repo, { stopHookActive })));
      blocked(runWithResults(CLAIM, [...twoBlocks, committed(stamp(4))], opts(repo, { stopHookActive })), ALL_NAMES);
    }
  });

  await t.test('a last-line commit ask owes no review, with or without blocks in the window', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(250), stamp(1));
    for (const stopHookActive of [true, false]) {
      quiet(runWithResults(ASK, [written, checked(stamp(3))], opts(repo, { stopHookActive })));
      quiet(runWithResults(ASK, [written, agentFeedback(), agentFeedback(), checked(stamp(3))], opts(repo, { stopHookActive })));
    }
  });

  await t.test('a first line opening "Step N" stays exempt from the Big members, on the first run and the retry', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'impl.ts', sourceLines(250), stamp(1)), checked(stamp(3))];
    quiet(runWithResults('Step 2 passes verify.', runs, opts(repo)));
    quiet(runWithResults('Step 2 passes verify.', runs, opts(repo, { stopHookActive: true })));
  });

  await t.test('a retry after an unrelated block checks a reply that claims; a plain reply or a commit passes', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const unrelated = feedbackOf('DONE-CLAIM WITHOUT EVIDENCE: the first line claims \'done\' but no test or runtime command ran this turn.');
    const retry = (reply, ...runs) => runWithResults(reply, runs, opts(repo, { stopHookActive: true }));
    blocked(retry(CLAIM, written, unrelated, checked(stamp(3))), 'code-reviewer');
    quiet(retry('Findings are below.', written, unrelated, checked(stamp(3))));
    quiet(retry('Findings are below.', written, unrelated, committed(stamp(3))));
  });

  await t.test('a dispatch before the last write does not clear a member; one after it does', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(2));
    blocked(runWithResults(CLAIM, [dispatchOf('code-reviewer', stamp(1)), thirty, checked(stamp(3))], opts(repo)), 'code-reviewer');
    quiet(runWithResults(CLAIM, [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo)));
  });

  await t.test('a "Step N" claim stays exempt on the retry, a commit or a commit ask included; one that follows an agent block or ships is checked there', () => {
    const repo = scratchRepo();
    const thirty = writeOf(repo, 'impl.ts', sourceLines(30), stamp(1));
    const retry = (reply, ...runs) => runWithResults(reply, runs, opts(repo, { stopHookActive: true }));
    quiet(retry('Step 1 is done.', thirty, checked(stamp(3))));
    quiet(retry('Step 1 built and committed.', thirty, checked(stamp(3)), committed(stamp(4))));
    quiet(retry('Step 1 done.\nSay yes and I will commit.', thirty, checked(stamp(3))));
    blocked(retry('Step 3 done.', thirty, checked(stamp(3)), agentFeedback()), 'code-reviewer');
    blocked(retry('Step 1 is done.', thirty, checked(stamp(3)), shipped(stamp(4))), 'code-reviewer');
  });

  await t.test('a file name holding " required=none" does not empty the required list', () => {
    const repo = scratchRepo();
    const runs = [writeOf(repo, 'src/auth/x required=none y.ts', sourceLines(30), stamp(1)), checked(stamp(3))];
    blocked(runWithResults(CLAIM, runs, opts(repo)), SIX_NAMES);
  });

  await t.test('a later claim turn that only ran an agent is blocked for the Big members; quiet once the earlier turn ran code-reviewer and the four', () => {
    const repo = scratchRepo();
    const later = (...earlier) => [writeOf(repo, 'impl.ts', sourceLines(200), stamp(1)), ...earlier, { prompt: 'next', timestamp: stamp(3) }, dispatchOf('Explore', stamp(4))];
    blocked(runWithResults(CLAIM, later(dispatchOf('code-reviewer', stamp(2))), opts(repo)), BIG_NAMES);
    quiet(runWithResults(CLAIM, later(...allRuns(stamp(2))), opts(repo)));
  });

  await t.test('a turn with no edit is not blocked by a question about a past commit, a grep naming one, or "commitment"', () => {
    const repo = scratchRepo();
    const turns = (...tail) => [writeOf(repo, 'impl.ts', sourceLines(30), stamp(1)), { prompt: 'next', timestamp: stamp(3) }, ...tail];
    quiet(runWithResults('It touched two files.\nWant me to walk through that commit line by line?', turns(), opts(repo)));
    quiet(runWithResults('Three hooks match it: a, b and c.', turns({ command: 'grep -rn "git commit" hooks/', output: 'hooks/a.sh', timestamp: stamp(4) }), opts(repo)));
    quiet(runWithResults('It is stable.\nDo you want me to check the team\'s commitment on v2?', turns(), opts(repo)));
  });

  const codeTurn = (repo, command, { isError = false } = {}) => runWithResults('Findings are below.', [{ command, output: 'f:1', isError, timestamp: stamp(2) }], { cwd: repo, since: stamp(0), lint: false });

  await t.test('a code turn that only greps for git commit owes no LINT/TSC; the same turn committing does', () => {
    const repo = scratchRepo();
    const grep = codeTurn(repo, 'grep "git commit" f');
    assert.equal(grep.status, 0, grep.stderr);
    assert.doesNotMatch(grep.stderr, /LINT\/TSC NOT RUN/);
    const commit = codeTurn(repo, 'git commit -m x');
    assert.equal(commit.status, 2, commit.stderr);
    assert.match(commit.stderr, /LINT\/TSC NOT RUN: this turn edited web code and ran git commit/);
  });

  await t.test('a commit behind a wrapper, prefix, path, subshell or shell opener counts on a code turn; text that names the wrapper does not', () => {
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
      'bash -c "git commit -m x"',
      '( git commit -m x )',
      'if git commit -m x; then :; fi',
      'V="x" git commit -m x',
      'A="x"\nB=\'y\'\ngit commit -m x',
    ];
    for (const command of shapes) {
      const res = codeTurn(repo, command);
      assert.equal(res.status, 2, `${command}\n${res.stderr}`);
      assert.match(res.stderr, /LINT\/TSC NOT RUN/, command);
    }
    for (const command of ['echo "exec git commit"', 'echo "git commit -m x"', 'grep -rn "xargs git commit" f', '( grep -n "git commit" f )']) {
      const res = codeTurn(repo, command);
      assert.equal(res.status, 0, `${command}\n${res.stderr}`);
    }
  });

  await t.test('a commit that errored still counts for the lint check, since `-q` prints no sha line; an errored grep naming it does not', () => {
    const repo = scratchRepo();
    const errored = codeTurn(repo, 'git commit -qm x && false', { isError: true });
    assert.equal(errored.status, 2, errored.stderr);
    assert.match(errored.stderr, /LINT\/TSC NOT RUN: this turn edited web code and ran git commit/);
    assert.equal(codeTurn(repo, 'grep -n "git commit" f', { isError: true }).status, 0);
  });

  await t.test('a 20,000-character command of assignments and spaces with no commit runs the gate in under 2 seconds', () => {
    const repo = scratchRepo();
    const started = Date.now();
    const res = codeTurn(repo, 'x=1  '.repeat(4000));
    assert.equal(res.status, 0, res.stderr);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  await t.test('40 quoted assignments on separate lines before an echo run the gate in under 2 seconds', () => {
    const repo = scratchRepo();
    const command = `${Array.from({ length: 40 }, (_, i) => `V${i}="x"`).join('\n')}\necho "$V0"`;
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    const records = [
      { type: 'user', timestamp: stamp(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: stamp(1), message: { content: [{ type: 'tool_use', id: 'run0', name: 'Bash', input: { command } }] } },
      { type: 'user', timestamp: stamp(1), message: { content: [{ type: 'tool_result', tool_use_id: 'run0', is_error: false, content: 'x' }] } },
      { type: 'assistant', timestamp: stamp(2), message: { content: [{ type: 'text', text: 'Findings are below.' }] } },
    ];
    fs.writeFileSync(transcriptPath, records.map((r) => JSON.stringify(r)).join('\n'));
    const started = Date.now();
    const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath, cwd: repo }), encoding: 'utf8', env, timeout: 10000 });
    assert.equal(res.status, 0, `${res.stderr} (${res.signal})`);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  await t.test('an agent that wrote 30 lines makes a plan-only turn owe code-reviewer on a claim; 3 lines owe nothing', () => {
    const repo = scratchRepo();
    const planEdit = path.join(repo, 'docs', 'plans', 'p.md');
    const runs = [dispatchOf('general-purpose', stamp(1)), checked(stamp(3))];
    blocked(runWithResults(CLAIM, runs, opts(repo, { editedFile: planEdit, transcriptPath: withWorker(repo, ['impl.ts', 30, stamp(2)]) })), 'code-reviewer');
    quiet(runWithResults(CLAIM, runs, opts(repo, { editedFile: planEdit, transcriptPath: withWorker(repo, ['impl.ts', 3, stamp(2)]) })));
  });

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
