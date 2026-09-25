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

let seq = 0;
function runFull(reply, { bashCommand, editedFile = '/repo/src/app.ts', stopHookActive = false, reviews = [], cwd, prompt = 'go' } = {}) {
  const content = [...reviews, { type: 'text', text: reply }];
  if (editedFile) content.unshift({ type: 'tool_use', name: 'Edit', input: { file_path: editedFile } });
  if (bashCommand) content.unshift({ type: 'tool_use', name: 'Bash', input: { command: bashCommand } });
  const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', message: { content: prompt } }),
    JSON.stringify({ type: 'assistant', message: { content } }),
  ].join('\n'));
  const payload = { transcript_path: transcriptPath, stop_hook_active: stopHookActive, cwd };
  return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8' });
}
const run = (reply, opts) => runFull(reply, opts).status;

test('done-claim gate', async (t) => {
  await t.test('blocks a claim with no test or runtime command this turn', () => {
    assert.equal(run('Done: the edits landed.'), 2);
    assert.equal(run('Tests passes now.'), 2);
  });

  await t.test('allows a claim backed by a test run and every named lens', () => {
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { bashCommand: 'node --test tests/*.test.js' }), 0);
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

  await t.test('counts a browser MCP call or an external-io run as runtime evidence', () => {
    const snapshot = { type: 'tool_use', name: 'mcp__chrome-devtools__take_snapshot', input: {} };
    const worker = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'external-io' } };
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [snapshot] }), 0);
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [worker] }), 0);
    const listing = { type: 'tool_use', name: 'mcp__claude_ai_Figma__get_metadata', input: {} };
    assert.equal(run(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [listing] }), 2);
  });

  await t.test('a review verb named in the prompt needs real member calls, even on a no-edit turn', () => {
    const agent = (subagent_type) => ({ type: 'tool_use', name: 'Agent', input: { subagent_type } });
    const skill = (name) => ({ type: 'tool_use', name: 'Skill', input: { skill: name } });
    const { status, stderr } = runFull('adversarial-reviewer: 0 findings\nsecurity-review: 0 findings', { editedFile: null, prompt: 'harden the auth hook' });
    assert.equal(status, 2);
    assert.match(stderr, /NAMED VERB NOT RUN[\s\S]*`harden`[\s\S]*adversarial-reviewer, security-review/);
    assert.equal(run('Two findings below.', { editedFile: null, prompt: 'harden the auth hook', reviews: [skill('adversarial-reviewer'), skill('security-review')] }), 0);
    const battery = ['code-reviewer', 'silent-failure-hunter', 'type-design-analyzer', 'reuse-analyzer', 'placement-analyzer', 'comment-analyzer', 'modern-ts-analyzer'];
    assert.equal(run('Findings below.', { editedFile: null, prompt: 'run the battery', reviews: battery.slice(1).map(agent) }), 2);
    assert.equal(run('Findings below.', { editedFile: null, prompt: 'run the battery', reviews: battery.map((m) => agent(`pr-review-toolkit:${m}`)) }), 0);
  });

  await t.test('a question about a verb is not a request for it', () => {
    assert.equal(run('It runs seven agents.', { editedFile: null, prompt: 'what does the battery run?' }), 0);
  });

  await t.test('skips the retry after a block', () => {
    assert.equal(run('Done.', { stopHookActive: true }), 0);
  });
});
