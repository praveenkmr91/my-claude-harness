'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('agent-file-scope: flags writes outside the brief, tolerates a sentence-ending path', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scope-'));
  fs.mkdirSync(path.join(home, '.claude', 'hooks-logs'), { recursive: true });
  const listed = path.join(home, 'listed.txt');
  const unlisted = path.join(home, 'unlisted.txt');
  fs.writeFileSync(listed, '');
  fs.writeFileSync(unlisted, '');
  const transcript = path.join(home, 'agent.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: `Edit ${listed}.` } }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: listed } },
      { type: 'tool_use', name: 'Write', input: { file_path: unlisted } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/private/tmp/claude-501/x/scratchpad/notes.md' } },
    ] } }),
  ].join('\n'));
  const payload = JSON.stringify({ stop_hook_active: false, agent_type: 'test', cwd: home, agent_transcript_path: transcript });
  const out = execFileSync('bash', [path.join(ROOT, 'hooks', 'agent-file-scope.sh')], { input: payload, encoding: 'utf8', env: { ...process.env, HOME: home } });
  const message = JSON.parse(out).systemMessage;
  assert.match(message, new RegExp(unlisted));
  assert.doesNotMatch(message, new RegExp(listed));
  assert.doesNotMatch(message, /scratchpad/);
  fs.rmSync(home, { recursive: true, force: true });
});
