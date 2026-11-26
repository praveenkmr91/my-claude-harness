'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir, LEARN_SKIP, RAW_OUTPUT, env, runWithResults } = require('./helpers/done-claim-gate');
const {
  stamp, sourceLines, withCatch, CLAIM, ASK, scratchRepo, writeOf, dispatchOf, resultOf, checked, committed, shipped,
  opts, blocked, quiet, ALL_NAMES, allRuns,
} = require('./helpers/done-claim-gate-agents');

test('done-claim gate: review agents on shipping commits, classifier failures and small turns', async (t) => {
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
    const printedThenErrored = { ...printed, command: `${printed.command} && false`, isError: true };
    blocked(runWithResults(`Step 3 done.\n${LEARN_SKIP}`, [written, checked(stamp(3)), printedThenErrored], opts(repo)), ALL_NAMES);
    const detached = { ...printed, output: shippedEarlier.stdout.replace(/^\[\S+ /, '[detached HEAD ') };
    assert.match(detached.output, /^\[detached HEAD [0-9a-f]{7,}\]/);
    blocked(runWithResults(`Step 3 done.\n${LEARN_SKIP}`, [written, checked(stamp(3)), detached], opts(repo)), ALL_NAMES);
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
});
