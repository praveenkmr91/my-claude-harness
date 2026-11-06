'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'done-claim-gate.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-claim-gate-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_VERDICTS = 'reuse-analyzer: 0 findings\nplacement-analyzer: skip — single-file change';
const LENS_SKIPS = 'reuse-analyzer: skip — rename only\nplacement-analyzer: skip — nothing moved';
const LEARN_SKIP = 'learn: skip — nothing new this build';
const RAW_OUTPUT = 'Raw output: /private/tmp/s/scratchpad/step1-checks.txt';
const LENS_AGENTS = ['reuse-analyzer', 'placement-analyzer'].map((subagent_type) => ({ type: 'tool_use', name: 'Agent', input: { subagent_type } }));

const handBack = (name) => ({
  type: 'user',
  isMeta: true,
  origin: { kind: 'peer', from: 'a1b2c3', senderTaskId: 'a1b2c3', name, body: '[Subagent hand-back] Step 1 done.', handback: true },
  message: { content: 'Another Claude session sent a message:\n<agent-message from="a1b2c3">\n[Subagent hand-back] Step 1 done.' },
});
const handBackAttachment = (name) => ({
  type: 'attachment',
  attachment: {
    type: 'queued_command',
    commandMode: 'prompt',
    prompt: '<agent-message from="a1b2c3">\n[Subagent hand-back] Step 1 done.',
    origin: { kind: 'peer', from: 'a1b2c3', senderTaskId: 'a1b2c3', name, body: '[Subagent hand-back] Step 1 done.', handback: true, handbackReportText: 'Step 1 done.' },
  },
});
const reportSend = (message, id) => ({ type: 'tool_use', id, name: 'SendMessage', input: { to: 'planner-1', message } });
const sendPayload = (transcriptPath, message, cwd) => ({ transcript_path: transcriptPath, cwd, tool_name: 'SendMessage', tool_input: { to: 'planner-1', message } });

const repoWith = (scripts) => {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts }));
  return repo;
};

// Under the pre-commit hook git exports GIT_INDEX_FILE etc.; inherited, they point a scratch repo at ~/.claude's index.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

let seq = 0;
// `send: true` replays the reply as a pending SendMessage (its tool_use already in the transcript) through the PreToolUse arm.
function runFull(reply, { bashCommand, editedFile = '/repo/src/app.ts', lint = true, stopHookActive = false, reviews = [], cwd, prompt = 'go', handback, send = false } = {}) {
  const content = [...reviews, send ? reportSend(reply, 'send') : { type: 'text', text: reply }];
  if (editedFile) content.unshift({ type: 'tool_use', name: 'Edit', input: { file_path: editedFile } });
  if (bashCommand) content.unshift({ type: 'tool_use', name: 'Bash', input: { command: bashCommand } });
  if (lint) content.unshift({ type: 'tool_use', name: 'Bash', input: { command: 'pnpm lint && pnpm tsc --noEmit' } });
  const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    { type: 'user', message: { content: prompt } },
    ...(handback ? [handback] : []),
    { type: 'assistant', message: { content } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  const payload = send ? sendPayload(transcriptPath, reply, cwd) : { transcript_path: transcriptPath, stop_hook_active: stopHookActive, cwd };
  return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8' });
}
const run = (reply, opts) => runFull(reply, opts).status;

// `send: true` replays the reply as a SendMessage whose tool_use is not yet in the transcript.
function runWithResults(reply, runs, { lint = true, editedFile = '/repo/src/app.ts', send = false, cwd, since } = {}) {
  const lines = [{ type: 'user', timestamp: since, message: { content: 'go' } }];
  const prelude = [];
  if (lint) prelude.push({ type: 'tool_use', id: 'lint', name: 'Bash', input: { command: 'pnpm lint && pnpm tsc --noEmit' } });
  if (editedFile) prelude.push({ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: editedFile } });
  if (prelude.length) lines.push({ type: 'assistant', message: { content: prelude } });
  runs.forEach(({ command, sent, handback, record, prompt, blocks, isError = false, output }, i) => {
    if (handback || record) {
      lines.push(handback ?? record);
    } else if (blocks) {
      lines.push({ type: 'assistant', message: { content: blocks } });
    } else if (prompt) {
      lines.push({ type: 'user', message: { content: prompt } });
    } else {
      const toolUse = sent ? reportSend(sent, `run${i}`) : { type: 'tool_use', id: `run${i}`, name: 'Bash', input: { command } };
      lines.push({ type: 'assistant', message: { content: [toolUse] } });
      lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `run${i}`, is_error: isError, content: output }] } });
    }
  });
  if (!send) lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `${reply}\n${BASE_VERDICTS}` }] } });
  const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));
  const payload = send ? sendPayload(transcriptPath, reply, cwd) : { transcript_path: transcriptPath, cwd };
  return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8', env });
}

test('done-claim gate', async (t) => {
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

  await t.test('names only the lenses without a verdict line or a run', () => {
    const ask = 'Diff is above.\nSay yes and I will commit.';
    const { status, stderr } = runFull(`reuse-analyzer: 0 findings\n${ask}`);
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for placement-analyzer:/);
    const placementAgent = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'placement-analyzer' } };
    assert.equal(run(`reuse-analyzer: 0 findings\n${ask}`, { reviews: [placementAgent] }), 0);
  });

  await t.test('a skip without a reason, or a bare definition Read, is not a verdict', () => {
    const ask = 'Diff is above.\nSay yes and I will commit.';
    assert.equal(run(`reuse-analyzer: skip\nplacement-analyzer: skip —\n${ask}`), 2);
    const reads = ['reuse-analyzer', 'placement-analyzer'].map((name) => ({ type: 'tool_use', name: 'Read', input: { file_path: `/Users/x/.claude/agents/${name}.md` } }));
    assert.equal(run(ask, { reviews: reads }), 2);
  });

  await t.test('a lens verdict is accepted in bold, backtick and bullet label forms and with no findings', () => {
    const ask = 'Diff is above.\nSay yes and I will commit.';
    for (const verdicts of [
      '- **reuse-analyzer:** no findings. The path filter extends the existing hook.\n`placement-analyzer`: 0 findings',
      'reuse-analyzer: no findings\n* **placement-analyzer**: skipped. Single-file change.',
      '`reuse-analyzer:` 2 findings\nplacement-analyzer: skip: nothing moved',
    ]) {
      assert.equal(run(`${verdicts}\n${ask}`), 0, verdicts);
    }
  });

  await t.test('a lens name followed by prose is not a verdict', () => {
    const ask = 'Diff is above.\nSay yes and I will commit.';
    assert.equal(run(`reuse-analyzer: looks fine\nplacement-analyzer: skipped\n${ask}`), 2);
  });

  await t.test('verdict lines do not mask the first-line claim or the last-line commit ask', () => {
    const { status, stderr } = runFull(`${BASE_VERDICTS}\nDone: the edits landed.`);
    assert.equal(status, 2);
    assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.equal(run(`Diff is above.\nSay yes and I will commit.\n${BASE_VERDICTS}`), 0);
    assert.match(runFull(`Diff is above.\nSay yes and I will commit.\nreuse-analyzer: 0 findings`).stderr, /asks to commit/);
  });

  await t.test('requires the content-signalled reviewer, satisfied by its plugin agent', () => {
    const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    fs.writeFileSync(path.join(repo, 'api.ts'), 'p.catch(() => null);');
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const ask = 'Diff is above.\nSay yes and I will commit.';
    assert.match(runFull(`${BASE_VERDICTS}\n${ask}`, { cwd: repo }).stderr, /REVIEW NOT RUN for silent-failure-hunter:/);
    const hunter = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'pr-review-toolkit:silent-failure-hunter' } };
    assert.equal(run(`${BASE_VERDICTS}\n${ask}`, { cwd: repo, reviews: [hunter] }), 0);
  });

  await t.test('names the verb the classifier picks for the repo', () => {
    const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    fs.mkdirSync(path.join(repo, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'auth', 'useAuth.ts'), '');
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const { stderr } = runFull('Diff is above.\nSay yes and I will commit.', { cwd: repo });
    assert.match(stderr, /`harden` pass/);
  });

  await t.test('ignores the noun form of "passes"', () => {
    assert.equal(run('Nothing says who applies fix passes.'), 0);
    assert.equal(run('Two review passes ran.'), 0);
  });

  await t.test('ignores negations and questions', () => {
    assert.equal(run('Not done yet: two edits remain.'), 0);
    assert.equal(run('Is this done?'), 0);
  });

  await t.test('ignores turns that edited no code file', () => {
    assert.equal(run('Done: saved that as feedback in memory.', { editedFile: null }), 0);
    assert.equal(run('Committed 8dca3c4, lint-staged green.', { editedFile: null, bashCommand: 'git commit -m x' }), 0);
    assert.equal(run('Done: the rule doc is updated.', { editedFile: '/repo/CLAUDE.md' }), 0);
  });

  await t.test('counts a Bash write to a code file as an edit', () => {
    assert.equal(run('Fixed.', { editedFile: null, bashCommand: "sed -i '' 's/a/b/' src/app.tsx" }), 2);
  });

  await t.test('counts a browser MCP call or a browser-verifier run as runtime evidence', () => {
    const snapshot = { type: 'tool_use', name: 'mcp__chrome-devtools__take_snapshot', input: {} };
    const worker = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'external-io' } };
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [snapshot] }), 0);
    const ioRun = runFull(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [worker] });
    assert.equal(ioRun.status, 2);
    assert.match(ioRun.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    const listing = { type: 'tool_use', name: 'mcp__claude_ai_Figma__get_metadata', input: {} };
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [listing] }), 2);
    const verifierRun = (handback, from = 'a1') => {
      const verifierPath = path.join(tmpDir, `t${seq++}.jsonl`);
      fs.writeFileSync(verifierPath, [
        { type: 'user', message: { content: 'go' } },
        { type: 'assistant', message: { content: [
          { type: 'tool_use', id: 'lint', name: 'Bash', input: { command: 'pnpm lint && pnpm tsc --noEmit' } },
          { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/repo/src/app.ts' } },
          { type: 'tool_use', id: 'verify', name: 'Agent', input: { subagent_type: 'browser-verifier' } },
        ] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'verify', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a1 (internal ID)' }] }] } },
        ...(handback ? [{ type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n<agent-message from="${from}">\n${handback}` } }] : []),
        { type: 'assistant', message: { content: [{ type: 'text', text: `Done: the edits landed.\n${BASE_VERDICTS}` }] } },
      ].map((r) => JSON.stringify(r)).join('\n'));
      return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: verifierPath }), encoding: 'utf8' });
    };
    const passStep = '  1. open /login — pass — snapshot shows the form\n';
    assert.equal(verifierRun(passStep).status, 0);
    assert.equal(verifierRun(passStep, 'zz').status, 2);
    const blockedRun = verifierRun(`${passStep}  2. submit — blocked — button has no effect\n`);
    assert.equal(blockedRun.status, 2);
    assert.match(blockedRun.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.equal(verifierRun(null).status, 2);
    const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'lint', name: 'Bash', input: { command: 'pnpm lint && pnpm tsc --noEmit' } },
        { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/repo/src/app.ts' } },
        { type: 'tool_use', id: 'click', name: 'mcp__chrome-devtools__click', input: { uid: '1_2' } },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'click', is_error: true, content: 'Browser actions run off the main thread (~/.claude/external-io.md): dispatch browser-verifier for a verification, or fork for a debug that needs this context. Praveen lifts it for one turn by typing [browser-inline: <why>].' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `Done: the edits landed.\n${BASE_VERDICTS}` }] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const { status, stderr } = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    assert.equal(status, 2);
    assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
  });

  await t.test('a `Pass: <verb>` line in the reply needs real member calls, even on a no-edit turn', () => {
    const agent = (subagent_type) => ({ type: 'tool_use', name: 'Agent', input: { subagent_type } });
    const skill = (name) => ({ type: 'tool_use', name: 'Skill', input: { skill: name } });
    const { status, stderr } = runFull('Pass: harden\nadversarial-reviewer: 0 findings\nsecurity-review: 0 findings', { editedFile: null });
    assert.equal(status, 2);
    assert.match(stderr, /NAMED VERB NOT RUN[\s\S]*`Pass: harden`[\s\S]*adversarial-reviewer, security-review/);
    assert.equal(run('Pass: harden\nTwo findings below.', { editedFile: null, reviews: [skill('adversarial-reviewer'), skill('security-review')] }), 0);
    assert.equal(run('Pass: harden\nTwo findings below.', { editedFile: null, reviews: [agent('adversarial-reviewer'), skill('security-review')] }), 0);
    const battery = ['code-reviewer', 'silent-failure-hunter', 'type-design-analyzer', 'reuse-analyzer', 'placement-analyzer', 'comment-analyzer', 'modern-ts-analyzer'];
    assert.equal(run('Pass: battery\nFindings below.', { editedFile: null, reviews: battery.slice(1).map(agent) }), 2);
    assert.equal(run('Pass: battery\nFindings below.', { editedFile: null, reviews: battery.map((m) => agent(`pr-review-toolkit:${m}`)) }), 0);
  });

  await t.test('a bullet, bold or backtick `Pass:` label counts as the announcement', () => {
    assert.equal(run('- **Pass:** trim\nFindings below.', { editedFile: null }), 2);
    assert.equal(run('`Pass:` trim\nFindings below.', { editedFile: null }), 2);
    assert.equal(run('pass: trim\nFindings below.', { editedFile: null }), 2);
  });

  await t.test('a named-verb member declared `not run — <reason>` counts as handled; undeclared members stay missing', () => {
    const opts = { editedFile: null };
    assert.equal(run('Pass: harden\nsecurity-review: not run — ran last turn on the same diff\nadversarial-reviewer: not run — same', opts), 0);
    const { status, stderr } = runFull('Pass: harden\nsecurity-review: not run — ran last turn on the same diff', opts);
    assert.equal(status, 2);
    assert.match(stderr, /no Skill\/Agent call ran for adversarial-reviewer\./);
    assert.match(stderr, /`<member>: not run — <reason>`/);
  });

  await t.test('talking about a verb is not announcing it: the prompt is never read, and `Pass:` must start a line', () => {
    assert.equal(run('Findings below.', { editedFile: null, prompt: 'run the battery' }), 0);
    assert.equal(run('The battery now accepts a model.', { editedFile: null, prompt: 'i want battery review to also accept model' }), 0);
    assert.equal(run('See Pass: battery in the routing doc.', { editedFile: null }), 0);
    assert.equal(run('', { editedFile: null }), 0);
  });

  await t.test('isMeta records (skill bodies, hand-backs, hook feedback) do not reset the turn', () => {
    const skill = (name) => ({ type: 'tool_use', name: 'Skill', input: { skill: name } });
    const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'harden the auth hook' } },
      { type: 'assistant', message: { content: [skill('adversarial-reviewer'), skill('security-review')] } },
      { type: 'user', isMeta: true, message: { content: 'You are a senior security engineer doing a security review' } },
      { type: 'user', isMeta: true, message: { content: 'Stop hook feedback: this reply announces `Pass: trim`' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Pass: harden\nTwo findings below.' }] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const { status } = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    assert.equal(status, 0);
  });

  await t.test('an implementer nudge needs a dispatch or verdict line in the same turn', () => {
    const runNudged = (reply) => {
      const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
      fs.writeFileSync(transcriptPath, [
        { type: 'user', message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'This Opus thread is about to write source (/repo/src/app.ts) with no `implementer` dispatch this turn.' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
      ].map((e) => JSON.stringify(e)).join('\n'));
      return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    };
    const silent = runNudged('Notes updated.');
    assert.equal(silent.status, 2);
    assert.match(silent.stderr, /IMPLEMENTER NUDGE UNANSWERED/);
    assert.equal(runNudged('implementer: skip — design edits, nearly done.\nNotes updated.').status, 0);
    for (const line of [
      "- **implementer:** skipped. The remaining edits are a few small, interlinked harness changes.",
      "implementer: skipped. This is a single small hook that I'm testing directly.",
      '**implementer**: skip — reason',
      '`implementer`: dispatching',
    ]) {
      assert.equal(runNudged(`${line}\nNotes updated.`).status, 0, line);
    }
    for (const line of ['implementer: skipped', 'implementer: skip —', 'implementer:']) {
      assert.equal(runNudged(`${line}\nNotes updated.`).status, 2, line);
    }
  });

  await t.test('a write-block arrives as an errored tool_result and no implementer verdict follows', () => {
    const runNudged = (reply) => {
      const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
      fs.writeFileSync(transcriptPath, [
        { type: 'user', message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/notes.md' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'PreToolUse:Write hook error: [bash …opus-write-nudge.sh]: This Opus thread is about to write source (/repo/notes.md) with no `implementer` dispatch this turn. …' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
      ].map((e) => JSON.stringify(e)).join('\n'));
      return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    };
    const silent = runNudged('Notes updated.');
    assert.equal(silent.status, 2);
    assert.match(silent.stderr, /IMPLEMENTER NUDGE UNANSWERED/);
    assert.equal(runNudged('implementer: dispatching\nNotes updated.').status, 0);
  });

  await t.test('tool output quoting the write-block text is not a block', () => {
    const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/notes.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'diff output quoting: This Opus thread is about to write source (/repo/notes.md) with no `implementer` dispatch this turn.' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Notes updated.' }] } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const { status, stderr } = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    assert.equal(status, 0, stderr);
  });

  await t.test('reads verdicts from last_assistant_message when the transcript lags', () => {
    const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'pnpm lint && node --test && git commit -m x' } }] } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const payload = (extra) => JSON.stringify({ transcript_path: transcriptPath, ...extra });
    assert.equal(spawnSync('bash', [HOOK_PATH], { input: payload({}), encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync('bash', [HOOK_PATH], { input: payload({ last_assistant_message: `Done: edits landed.\n${BASE_VERDICTS}` }), encoding: 'utf8' }).status, 0);
  });

  await t.test('an implementer hand-back counts as a code change: the claim needs evidence and every lens', () => {
    for (const handback of [handBack('implementer'), handBackAttachment('implementer')]) {
      const { status, stderr } = runFull('Done: step 1 landed.', { editedFile: null, handback });
      assert.equal(status, 2);
      assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    }
    assert.equal(run(`Done: step 1 landed.\n${LEARN_SKIP}`, { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js', reviews: LENS_AGENTS }), 0);
    assert.equal(run('Done: step 1 landed.', { editedFile: null, handback: handBack('checker') }), 0);
    assert.equal(run('Done: step 1 landed.', { editedFile: null, handback: handBackAttachment('checker') }), 0);
  });

  await t.test('in a plan build a done-claim with hand-written findings lines stays blocked; a skip with a reason passes', () => {
    const built = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js' };
    const { status, stderr } = runFull('Done: step 1 landed.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', built);
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:[\s\S]*on a done-claim or shipping commit in a plan build a hand pass does not count/);
    assert.equal(run(`Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}`, built), 0);
  });

  await t.test('in a plan build a first line opening "Step N" is a step claim and passes on hand-pass lens lines', () => {
    const built = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js' };
    const handPass = 'reuse-analyzer: 0 findings\nplacement-analyzer: 0 findings';
    assert.equal(run(`Step 1 passes verify: 3,057 tests green.\n${handPass}`, built), 0);
    assert.equal(run(`**Step 3** is built and passes the full verify.\n${handPass}`, built), 0);
    const { status, stderr } = runFull('Step 2 passes verify.', built);
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer/);
    assert.doesNotMatch(stderr, /hand pass does not count/);
  });

  await t.test('a shipping commit that deletes the repo plan file needs each lens dispatched or skipped, with no hand-back', () => {
    const ship = { editedFile: null, lint: false, bashCommand: 'git rm docs/plans/demo.md && git commit -m ship' };
    const { status, stderr } = runFull('Shipped.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', ship);
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:[\s\S]*shipping commit in a plan build a hand pass does not count/);
    assert.equal(run(`Shipped.\n${LEARN_SKIP}`, { ...ship, reviews: LENS_AGENTS }), 0);
    assert.equal(run('Shipped.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', { ...ship, bashCommand: 'git rm docs/notes.md && git commit -m x' }), 0);
  });

  await t.test('a plan build done-claim or shipping commit needs one /learn pass in the transcript, or a learn skip line', () => {
    const built = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js', reviews: LENS_AGENTS };
    const { status, stderr } = runFull('Done: step 1 landed.', built);
    assert.equal(status, 2);
    assert.match(stderr, /LEARN NOT RUN/);
    const typed = '<command-message>learn</command-message>\n<command-name>/learn</command-name>';
    assert.equal(run('Done: step 1 landed.', { ...built, prompt: typed }), 0);
    assert.equal(run('Done: step 1 landed.', { ...built, reviews: [...LENS_AGENTS, { type: 'tool_use', name: 'Skill', input: { skill: 'learn' } }] }), 0);
    assert.equal(run(`Done: step 1 landed.\n${LEARN_SKIP}`, built), 0);
    // Near twins: a step claim, and a code edit with no hand-back, are not the build's done-claim.
    assert.doesNotMatch(runFull('Step 1 passes verify.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', { ...built, reviews: [] }).stderr, /LEARN NOT RUN/);
    assert.doesNotMatch(runFull('Done: typo fixed.', { bashCommand: 'node --test tests/*.test.js', reviews: LENS_AGENTS }).stderr, /LEARN NOT RUN/);
    const ship = { editedFile: null, lint: false, bashCommand: 'git rm docs/plans/demo.md && git commit -m ship', reviews: LENS_AGENTS };
    assert.match(runFull('Shipped.', ship).stderr, /LEARN NOT RUN/);
    assert.equal(run(`Shipped.\n${LEARN_SKIP}`, ship), 0);
  });

  await t.test('a hand-back keys the lint demand on the files its agent transcript shows it wrote; with no transcript named, the cwd decides', () => {
    const scripted = repoWith({ 'check:lint': 'oxlint .' });
    const tested = { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' };
    const agentRun = (id, files) => {
      const out = path.join(tmpDir, `${id}.output`);
      fs.writeFileSync(out, files.map((f) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: f } }] } })).join('\n'));
      const hb = handBack('implementer');
      hb.origin.from = id;
      return [
        { blocks: [{ type: 'tool_use', id: `dispatch-${id}`, name: 'Agent', input: { subagent_type: 'implementer' } }] },
        { record: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `dispatch-${id}`, content: `Async agent launched.\noutput_file: ${out}` }] } } },
        { handback: hb },
        tested,
      ];
    };
    const opts = { editedFile: null, lint: false, cwd: scripted };
    const reply = `Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}`;
    assert.doesNotMatch(runWithResults(reply, agentRun('ag1', [path.join(os.homedir(), '.claude/hooks/x.sh')]), opts).stderr, /LINT\/TSC/);
    assert.match(runWithResults(reply, agentRun('ag2', ['/repo/src/app.ts']), opts).stderr, /LINT\/TSC/);
    assert.match(runWithResults(reply, [{ handback: handBack('implementer') }, tested], opts).stderr, /LINT\/TSC/);
    const gone = agentRun('ag3', ['/repo/src/app.ts']);
    fs.rmSync(path.join(tmpDir, 'ag3.output'));
    assert.match(runWithResults(reply, gone, opts).stderr, /LINT\/TSC/);
  });

  await t.test('in a plan build a REPORT passes on hand-pass lens lines', () => {
    const report = `[REPORT demo step 1] Step 1 built.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings\n${RAW_OUTPUT}`;
    assert.equal(run(report, { editedFile: null, handback: handBack('implementer'), send: true, lint: false, bashCommand: 'node --test tests/*.test.js' }), 0);
  });

  await t.test('a hand-back needs lint and type check only where the repo defines a lint or type-check script', () => {
    const opts = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js', lint: false };
    const reply = `Done: step 1 landed.\n${LENS_SKIPS}`;
    const scripted = repoWith({ 'check:lint': 'eslint .' });
    assert.match(runFull(reply, { ...opts, cwd: scripted }).stderr, /LINT\/TSC NOT RUN/);
    assert.doesNotMatch(runFull(reply, { ...opts, cwd: repoWith({ build: 'vite build' }) }).stderr, /LINT\/TSC/);
    assert.doesNotMatch(runFull(reply, { ...opts, cwd: path.join(os.homedir(), '.claude') }).stderr, /LINT\/TSC/);
    assert.doesNotMatch(runFull(reply, { ...opts, cwd: scripted, bashCommand: 'node --test tests/*.test.js && pnpm lint' }).stderr, /LINT\/TSC/);
    spawnSync('git', ['init', '-q'], { cwd: scripted });
    const nested = path.join(scripted, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    assert.match(runFull(reply, { ...opts, cwd: nested }).stderr, /LINT\/TSC NOT RUN/);
    const repoPlan = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'implementer', prompt: `Implement step 1 of ${scripted}/plans/x.md` } };
    assert.match(runFull(reply, { ...opts, cwd: scripted, reviews: [repoPlan] }).stderr, /LINT\/TSC NOT RUN/);
  });

  await t.test('a harness plan dispatched before a typed prompt does not waive lint in a repo that defines it', () => {
    const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'implement' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'implementer', prompt: 'Implement step 1 of ~/.claude/plans/x.md' } }] } },
      { type: 'user', message: { content: 'how is it going?' } },
      handBack('implementer'),
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'node --test tests/*.test.js' } },
        { type: 'text', text: `Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}` },
      ] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const stop = (cwd) => spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath, cwd }), encoding: 'utf8' });
    const scripted = stop(repoWith({ lint: 'eslint .' }));
    assert.equal(scripted.status, 2);
    assert.match(scripted.stderr, /LINT\/TSC NOT RUN/);
    const unscripted = stop(repoWith({ build: 'vite build' }));
    assert.doesNotMatch(unscripted.stderr, /LINT\/TSC/);
    assert.equal(unscripted.status, 0, unscripted.stderr);
  });

  await t.test('the claim comes from the final reply, not the first text of the turn', () => {
    const { status, stderr } = runFull('Done: the edits landed.', { reviews: [{ type: 'text', text: 'Working on it.' }] });
    assert.equal(status, 2);
    assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.equal(run('Still red: two tests fail.', { reviews: [{ type: 'text', text: 'Done: the edits landed.' }] }), 0);
  });

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

  await t.test('skips the retry after a block', () => {
    assert.equal(run('Done.', { stopHookActive: true }), 0);
  });
});

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
  const assistant = (...content) => ({ type: 'assistant', message: { content } });
  const prompt = (text) => ({ type: 'user', message: { content: text } });
  const runPlan = (records, final, input = {}) => {
    const transcriptPath = path.join(tmpDir, `plan${seq++}.jsonl`);
    fs.writeFileSync(transcriptPath, records.map((r) => JSON.stringify(r)).join('\n'));
    return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath, last_assistant_message: final, ...input }), encoding: 'utf8', env });
  };
  const turn = (blocks, final) => [prompt('plan it'), assistant(...blocks), assistant({ type: 'text', text: final })];

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
    const quiet = runPlan(turn([...blocks, review('cold-reader', PLAN)], asks.typeRepo), asks.typeRepo);
    assert.equal(quiet.status, 0, quiet.stderr);
  });

  await t.test('blocks a reviewed plan with no advisor after its first review, quiet once the advisor ran', () => {
    const blocks = [writePlan(), review('dry-runner', `Dry-run ${PLAN}`)];
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
    const turn1 = [prompt('plan it'), assistant(writePlan(), review('cold-reader', PLAN), advisor), assistant({ type: 'text', text: 'Plan is ready.' })];
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
});
