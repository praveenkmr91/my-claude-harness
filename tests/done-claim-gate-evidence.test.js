'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { BASE_VERDICTS, run, runFull, runWithResults } = require('./helpers/done-claim-gate');

test('done-claim gate: evidence', async (t) => {
  await t.test('blocks a claim with no test or runtime command this turn', () => {
    assert.equal(run('Done: the edits landed.'), 2);
    assert.equal(run('Tests passes now.'), 2);
  });

  await t.test('allows a claim backed by a test run and every named lens', () => {
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { bashCommand: 'node --test tests/*.test.js' }), 0);
  });

  await t.test('blocks a claim when the last test run failed, by exit code or by fail marker', () => {
    for (const run of [
      { command: 'node --test tests/*.test.js', isError: true, output: 'Exit code 1\nℹ pass 3\nℹ fail 1' },
      { command: 'node --test tests/*.test.js 2>&1 | tail -3', output: 'ℹ pass 338\nℹ fail 1' },
      { command: 'pnpm vitest run | tail', output: ' FAIL  src/app.spec.ts > renders\n Tests  1 failed | 4 passed' },
      { command: 'npx playwright test | tail -2', output: '  2 failed\n  5 passed (12s)' },
    ]) {
      const { status, stderr } = runWithResults('Done: the edits landed.', [run]);
      assert.equal(status, 2, run.command);
      assert.match(stderr, /DONE-CLAIM OVER A FAILED RUN/, run.command);
    }
  });

  await t.test('allows a claim whose last test run is green, even after a red one', () => {
    const red = { command: 'node --test tests/*.test.js', isError: true, output: 'Exit code 1\nℹ fail 2' };
    const green = { command: 'node --test tests/*.test.js | grep -E "ℹ (pass|fail)"', output: 'ℹ pass 340\nℹ fail 0' };
    assert.equal(runWithResults('Done: the edits landed.', [red, green]).status, 0);
    assert.equal(runWithResults('Done: the edits landed.', [green]).status, 0);
    assert.equal(runWithResults('Done: the edits landed.', [{ command: 'pnpm test', output: [{ type: 'text', text: 'Tests  0 failed | 9 passed' }] }]).status, 0);
  });

  await t.test('blocks a tested claim when no review pass ran', () => {
    const { status, stderr } = runFull('Done: the edits landed.', { bashCommand: 'node --test tests/*.test.js' });
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer[\s\S]*`review` pass/);
    assert.doesNotMatch(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
  });

  await t.test('blocks a commit ask with no review pass', () => {
    const { status, stderr } = runFull('Diff is above.\nSay yes and I will commit.');
    assert.equal(status, 2);
    assert.match(stderr, /asks to commit/);
    assert.equal(run('Diff is above.\nCommitted as ae56e51. Want me to push?'), 0);
  });

  await t.test('blocks a web-code claim or commit ask when no lint or type check ran', () => {
    const claim = runFull(`Done: the edits landed.\n${BASE_VERDICTS}`, { bashCommand: 'node --test tests/*.test.js', lint: false });
    assert.equal(claim.status, 2);
    assert.match(claim.stderr, /LINT\/TSC NOT RUN: this turn edited web code and claims done/);
    assert.doesNotMatch(claim.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    const ask = runFull(`Diff is above.\nSay yes and I will commit.\n${BASE_VERDICTS}`, { lint: false });
    assert.match(ask.stderr, /LINT\/TSC NOT RUN: [\s\S]*asks to commit/);
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { bashCommand: 'pnpm check:types && node --test', lint: false }), 0);
  });

  await t.test('an automatic commit triggers the lint and review checks like a commit ask', () => {
    const noLint = runFull(`Committed as abc1234.\n${BASE_VERDICTS}`, { bashCommand: 'git -C /repo commit --only src/app.ts -m x', lint: false });
    assert.equal(noLint.status, 2);
    assert.match(noLint.stderr, /LINT\/TSC NOT RUN: this turn edited web code and ran git commit/);
    const noLens = runFull('Committed as abc1234.', { bashCommand: 'git commit -m x' });
    assert.match(noLens.stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer: [\s\S]*ran git commit/);
    assert.equal(run(`Committed as abc1234.\n${BASE_VERDICTS}`, { bashCommand: 'git commit -m x' }), 0);
    assert.equal(run('Here is the history.', { bashCommand: 'git log --grep commit', lint: false }), 0);
  });

  await t.test('a lint word outside command position is not a lint run', () => {
    for (const command of [
      'grep -n eslint package.json',
      'node ~/.claude/hooks/plan-lint.js docs/plans/x.md',
      'git log --grep verify',
      'npx prettier --check src',
      `pnpm ${'-s run '.repeat(30)}build`,
    ]) {
      const { status, stderr } = runFull(`Done: the edits landed.\n${BASE_VERDICTS}`, { bashCommand: `${command} && node --test`, lint: false });
      assert.equal(status, 2, command);
      assert.match(stderr, /LINT\/TSC NOT RUN/, command);
    }
  });

  await t.test('lint and type-check runs in the shapes the repos use pass', () => {
    for (const command of [
      'cd /repo && pnpm check:lint 2>&1 | tail -100',
      'pnpm run -s typecheck && echo ok',
      'time pnpm exec eslint src/a.tsx',
      'npx tsc --noEmit -p tsconfig.app.json',
      'pnpm --filter web lint:fix',
      'npm run ts:check',
      'oxlint --deny-warnings src',
      'S=/tmp/x; pnpm verify',
    ]) {
      assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { bashCommand: `${command} && node --test`, lint: false }), 0, command);
    }
  });

  await t.test('skips the lint check for non-web and harness edits', () => {
    const opts = { bashCommand: 'node --test tests/*.test.js', lint: false };
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { ...opts, editedFile: '/repo/scripts/release.sh' }), 0);
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { ...opts, editedFile: path.join(os.homedir(), '.claude', 'hooks', 'x.js') }), 0);
  });

  await t.test('a doc-only turn skips the review check even when a command redirects output next to a code name', () => {
    const docTurn = { editedFile: '/Users/x/.claude/CLAUDE.md', lint: false };
    assert.equal(run('Committed as abc1234.', { ...docTurn, bashCommand: 'node --test tests/*.test.js > /tmp/out.txt 2>&1 && git commit --only CLAUDE.md -m x' }), 0);
  });

  await t.test('a Bash write into a code file still triggers the review check', () => {
    for (const command of ['cat > src/app.ts <<EOF', 'echo x >> src/app.ts', 'echo x | tee -a src/app.ts', "sed -i '' 's/a/b/' src/app.ts"]) {
      const { status, stderr } = runFull('Committed as abc1234.', { editedFile: null, lint: false, bashCommand: `${command} && git commit -m x` });
      assert.equal(status, 2, command);
      assert.match(stderr, /REVIEW NOT RUN/, command);
    }
  });
});
