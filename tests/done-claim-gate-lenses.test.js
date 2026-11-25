'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HOOK_PATH, tmpDir, BASE_VERDICTS, CODE_REVIEW, nextSeq, scratchRepo, run, runFull } = require('./helpers/done-claim-gate');
const { SUITE_CONCURRENCY, launch } = require('./helpers/launch');

test.describe('done-claim gate: lenses', { concurrency: SUITE_CONCURRENCY }, () => {
  test('typed lens lines, skipped or not, change nothing: over unreviewed code a claim with none, all or hand-written ones is blocked alike, and a code-reviewer run clears it', async () => {
    const built = { bashCommand: 'node --test tests/*.test.js', cwd: await scratchRepo(), written: 30 };
    for (const verdicts of ['', `\n${BASE_VERDICTS}`, '\nreuse-analyzer: looks fine\nplacement-analyzer: skipped']) {
      const { status, stderr } = await runFull(`Done: the edits landed.${verdicts}`, built);
      assert.equal(status, 2, stderr);
      assert.match(stderr, /REVIEW AGENTS NOT RUN for code-reviewer:/);
    }
    assert.equal(await run('Done: the edits landed.', { ...built, reviews: [CODE_REVIEW] }), 0);
  });

  test('verdict lines do not mask the first-line claim or the last-line commit ask', async () => {
    const { status, stderr } = await runFull(`${BASE_VERDICTS}\nDone: the edits landed.`);
    assert.equal(status, 2);
    assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.equal(await run(`Diff is above.\nSay yes and I will commit.\n${BASE_VERDICTS}`), 0);
    assert.match((await runFull(`Diff is above.\nSay yes and I will commit.\nreuse-analyzer: 0 findings`, { lint: false })).stderr, /asks to commit/);
  });

  test('a styled turn owes the impeccable audit at its claim, never at a commit ask', async () => {
    const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    fs.writeFileSync(path.join(repo, 'a.css'), '.a { color: red; }\n');
    await launch('git', ['init', '-q'], { cwd: repo });
    const styled = { cwd: repo, editedFile: path.join(repo, 'a.css'), lint: false };
    const claim = await runFull('Done: the styling landed.', { ...styled, bashCommand: 'node --test tests/*.test.js' });
    assert.equal(claim.status, 2);
    assert.match(claim.stderr, /IMPECCABLE NOT RUN/);
    const audit = { type: 'tool_use', name: 'Skill', input: { skill: 'impeccable:impeccable' } };
    assert.equal(await run('Done: the styling landed.', { ...styled, bashCommand: 'node --test tests/*.test.js', reviews: [audit] }), 0);
    assert.equal((await runFull('Diff is above.\nSay yes and I will commit.', styled)).status, 0);
    assert.equal((await runFull('Committed as abc1234.', { ...styled, bashCommand: 'git commit -m x' })).status, 0);
  });

  test('ignores the noun form of "passes"', async () => {
    assert.equal(await run('Nothing says who applies fix passes.'), 0);
    assert.equal(await run('Two review passes ran.'), 0);
  });

  test('ignores negations and questions', async () => {
    assert.equal(await run('Not done yet: two edits remain.'), 0);
    assert.equal(await run('Is this done?'), 0);
  });

  test('ignores turns that edited no code file', async () => {
    assert.equal(await run('Done: saved that as feedback in memory.', { editedFile: null }), 0);
    assert.equal(await run('Committed 8dca3c4, lint-staged green.', { editedFile: null, bashCommand: 'git commit -m x' }), 0);
    assert.equal(await run('Done: the rule doc is updated.', { editedFile: '/repo/CLAUDE.md' }), 0);
  });

  test('counts a Bash write to a code file as an edit', async () => {
    assert.equal(await run('Fixed.', { editedFile: null, bashCommand: "sed -i '' 's/a/b/' src/app.tsx" }), 2);
  });

  test('counts a browser MCP call or a browser-verifier run as runtime evidence', async () => {
    const snapshot = { type: 'tool_use', name: 'mcp__chrome-devtools__take_snapshot', input: {} };
    const worker = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'external-io' } };
    assert.equal(await run(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [snapshot] }), 0);
    const ioRun = await runFull(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [worker] });
    assert.equal(ioRun.status, 2);
    assert.match(ioRun.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    const listing = { type: 'tool_use', name: 'mcp__claude_ai_Figma__get_metadata', input: {} };
    assert.equal(await run(`Done: the edits landed.\n${BASE_VERDICTS}`, { reviews: [listing] }), 2);
    const verifierRun = async (handback, from = 'a1') => {
      const verifierPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
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
      return launch('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: verifierPath }) });
    };
    const passStep = '  1. open /login — pass — snapshot shows the form\n';
    assert.equal((await verifierRun(passStep)).status, 0);
    assert.equal((await verifierRun(passStep, 'zz')).status, 2);
    const blockedRun = await verifierRun(`${passStep}  2. submit — blocked — button has no effect\n`);
    assert.equal(blockedRun.status, 2);
    assert.match(blockedRun.stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.equal((await verifierRun(null)).status, 2);
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
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
    const { status, stderr } = await launch('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }) });
    assert.equal(status, 2);
    assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
  });
});
