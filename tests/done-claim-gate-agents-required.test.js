'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, LEARN_SKIP, nextSeq, runWithResults } = require('./helpers/done-claim-gate');
const {
  stamp, sourceLines, withCatch, CLAIM, NOT_RUN, scratchRepo, writeOf, dispatchOf, skillOf, resultOf, checked, committed, shipped, landed,
  agentFeedback, opts, blocked, quiet, AGENT_MEMBERS, ALL_NAMES, BIG_NAMES, SIX_NAMES, allRuns, bigDispatches,
} = require('./helpers/done-claim-gate-agents');

test('done-claim gate: required review agents', async (t) => {
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

  await t.test('a claim over 30 lines holding a function declaration is blocked for code-reviewer and reuse-analyzer; quiet once both ran', () => {
    const repo = scratchRepo();
    const declared = writeOf(repo, 'impl.ts', sourceLines(30, 'export function build() { return 1; }'), stamp(1));
    blocked(runWithResults(CLAIM, [declared, checked(stamp(3))], opts(repo)), 'code-reviewer, reuse-analyzer');
    blocked(runWithResults(CLAIM, [declared, dispatchOf('code-reviewer', stamp(2)), checked(stamp(3))], opts(repo)), 'reuse-analyzer');
    quiet(runWithResults(CLAIM, [declared, dispatchOf('code-reviewer', stamp(2)), dispatchOf('reuse-analyzer', stamp(2)), checked(stamp(3))], opts(repo)));
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

  await t.test('"Step 3 done." with a plain commit over 300 uncovered lines owes no review; with the shipping commit it names every owed member', () => {
    const repo = scratchRepo();
    const written = writeOf(repo, 'impl.ts', sourceLines(300), stamp(1));
    quiet(runWithResults('Step 3 done.', [written, checked(stamp(3)), landed(stamp(4))], opts(repo)));
    blocked(runWithResults('Step 3 done.', [written, checked(stamp(3)), shipped(stamp(4))], opts(repo)), ALL_NAMES);
    quiet(runWithResults(`Step 3 done.\n${LEARN_SKIP}`, [written, ...allRuns(stamp(2)), checked(stamp(3)), shipped(stamp(4))], opts(repo)));
  });
});
