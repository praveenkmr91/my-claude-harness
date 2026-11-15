'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'step-gate.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-gate-'));
const writePlan = (...segments) => {
  const file = path.join(tmpDir, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# plan\n');
  return file;
};
const PLAN_FILE = writePlan('plans', 'demo.md');
const GHOST_PLAN = path.join(tmpDir, 'plans', 'ghost.md');
const PLAN_PROMPT = `Implement step 1.2 only of the approved plan ${PLAN_FILE}.`;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const assistant = (content) => ({ type: 'assistant', message: { model: 'claude-opus-5', content } });
const toolUse = (name, input, id = `tu-${name}`) => assistant([{ type: 'tool_use', id, name, input }]);
const dispatch = (subagentType, prompt = PLAN_PROMPT, id) => toolUse('Agent', { subagent_type: subagentType, prompt }, id);
const bash = (command, id) => toolUse('Bash', { command }, id);
const text = (t) => assistant([{ type: 'text', text: t }]);
const toolResult = (content, isError, id = 'tu-Agent') => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }] },
});
const bashResult = (content, isError, id = 'tu-Bash') => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }] },
});
const handBack = (name = 'implementer', report = 'Step 1.1 done.') => ({
  type: 'user',
  isMeta: true,
  origin: { kind: 'peer', from: 'a1b2c3', senderTaskId: 'a1b2c3', name, body: `[Subagent hand-back] ${report}`, handback: true },
  message: { content: `Another Claude session sent a message:\n<agent-message from="a1b2c3">\n[Subagent hand-back] ${report}` },
});
const handBackAttachment = (name = 'implementer') => ({
  type: 'attachment',
  attachment: {
    type: 'queued_command',
    commandMode: 'prompt',
    prompt: '<agent-message from="a1b2c3">\n[Subagent hand-back] Step 1.1 done.',
    origin: { kind: 'peer', from: 'a1b2c3', senderTaskId: 'a1b2c3', name, body: '[Subagent hand-back] Step 1.1 done.', handback: true, handbackReportText: 'Step 1.1 done.' },
  },
});
const HANDOFF_ENVELOPE = `<cross-session-message from="uds:/tmp/x.sock" from-name="planner-1" from-mode="prompting">\n[HANDOFF demo step 1] Rules: ~/.claude/peer-sessions.md\nPlan: ${PLAN_FILE}\n</cross-session-message>`;
const handoff = () => ({ type: 'user', isMeta: true, message: { content: `Another Claude session sent a message:\n${HANDOFF_ENVELOPE}` } });
const handoffAttachment = () => ({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, prompt: HANDOFF_ENVELOPE } });
const LAUNCHED = toolResult('Async agent launched successfully. agentId: a1b2c3');
const DRY_RUN = [dispatch('dry-runner', PLAN_PROMPT, 'tu-dry'), toolResult('Async agent launched successfully. agentId: d1', false, 'tu-dry')];
const STEP_DONE = [...DRY_RUN, dispatch('implementer'), LAUNCHED, handBack()];

let seq = 0;
function transcript(entries) {
  const p = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
  return p;
}

function run(entries, { subagentType = 'implementer', prompt = PLAN_PROMPT, agentId, transcriptPath, hookPath = HOOK_PATH, cwd, env } = {}) {
  const payload = {
    session_id: 'step-gate-test',
    agent_id: agentId,
    cwd,
    transcript_path: transcriptPath ?? transcript(entries),
    tool_input: { subagent_type: subagentType, prompt },
  };
  const res = spawnSync('bash', [hookPath], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: res.status, stderr: res.stderr };
}

function assertQuiet({ code, stderr }) {
  assert.equal(code, 0);
  assert.equal(stderr, '');
}

module.exports = {
  HOOK_PATH,
  tmpDir,
  writePlan,
  PLAN_FILE,
  GHOST_PLAN,
  PLAN_PROMPT,
  text,
  dispatch,
  bash,
  toolResult,
  bashResult,
  handBack,
  handBackAttachment,
  handoff,
  handoffAttachment,
  LAUNCHED,
  DRY_RUN,
  STEP_DONE,
  run,
  assertQuiet,
};
