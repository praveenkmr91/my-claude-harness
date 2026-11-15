'use strict';

const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
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
const nextSeq = () => seq++;
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
function runWithResults(reply, runs, { lint = true, editedFile = '/repo/src/app.ts', send = false, cwd, since, stopHookActive = false, home, transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`) } = {}) {
  const lines = [{ type: 'user', timestamp: since, message: { content: 'go' } }];
  const prelude = [];
  if (lint) prelude.push({ type: 'tool_use', id: 'lint', name: 'Bash', input: { command: 'pnpm lint && pnpm tsc --noEmit' } });
  if (editedFile) prelude.push({ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: editedFile } });
  if (prelude.length) lines.push({ type: 'assistant', message: { content: prelude } });
  runs.forEach(({ command, sent, handback, record, prompt, blocks, isError = false, output, timestamp }, i) => {
    if (handback || record) {
      lines.push(handback ?? record);
    } else if (blocks) {
      lines.push({ type: 'assistant', timestamp, message: { content: blocks } });
    } else if (prompt) {
      lines.push({ type: 'user', timestamp, message: { content: prompt } });
    } else {
      const toolUse = sent ? reportSend(sent, `run${i}`) : { type: 'tool_use', id: `run${i}`, name: 'Bash', input: { command } };
      lines.push({ type: 'assistant', timestamp, message: { content: [toolUse] } });
      lines.push({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: `run${i}`, is_error: isError, content: output }] } });
    }
  });
  if (!send) lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `${reply}\n${BASE_VERDICTS}` }] } });
  fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));
  const payload = send ? sendPayload(transcriptPath, reply, cwd) : { transcript_path: transcriptPath, cwd, ...(stopHookActive && { stop_hook_active: true }) };
  return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8', env: home ? { ...env, HOME: home } : env });
}

module.exports = {
  HOOK_PATH,
  tmpDir,
  BASE_VERDICTS,
  LENS_SKIPS,
  LEARN_SKIP,
  RAW_OUTPUT,
  LENS_AGENTS,
  handBack,
  handBackAttachment,
  repoWith,
  env,
  nextSeq,
  runFull,
  run,
  runWithResults,
};
