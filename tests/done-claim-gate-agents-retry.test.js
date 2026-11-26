'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOK_PATH, tmpDir, LENS_SKIPS, LEARN_SKIP, handBack, env, nextSeq, runWithResults } = require('./helpers/done-claim-gate');
const {
  stamp, sourceLines, withCatch, CLAIM, ASK, scratchRepo, writeOf, dispatchOf, checked, committed, shipped, landed,
  feedbackOf, agentFeedback, opts, blocked, quiet, ALL_NAMES, BIG_NAMES, SIX_NAMES, allRuns,
} = require('./helpers/done-claim-gate-agents');

test('done-claim gate: review agents on worker writes, retries and commits', async (t) => {
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
});
