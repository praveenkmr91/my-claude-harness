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

let seq = 0;
function run(reply, { bashCommand, editedFile = '/repo/src/app.ts', stopHookActive = false } = {}) {
  const content = [{ type: 'text', text: reply }];
  if (editedFile) content.unshift({ type: 'tool_use', name: 'Edit', input: { file_path: editedFile } });
  if (bashCommand) content.unshift({ type: 'tool_use', name: 'Bash', input: { command: bashCommand } });
  const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content } }),
  ].join('\n'));
  const payload = { transcript_path: transcriptPath, stop_hook_active: stopHookActive };
  return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8' }).status;
}

test('done-claim gate', async (t) => {
  await t.test('blocks a claim with no test or runtime command this turn', () => {
    assert.equal(run('Done: the edits landed.'), 2);
    assert.equal(run('Tests passes now.'), 2);
  });

  await t.test('allows a claim backed by a test run', () => {
    assert.equal(run('Done: the edits landed.', { bashCommand: 'node --test tests/*.test.js' }), 0);
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

  await t.test('skips the retry after a block', () => {
    assert.equal(run('Done.', { stopHookActive: true }), 0);
  });
});
