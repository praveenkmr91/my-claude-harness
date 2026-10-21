'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'browser-main-guard.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-main-guard-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const READ_TOOLS = ['list_pages', 'select_page', 'take_snapshot', 'take_screenshot', 'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request', 'get_css_styles', 'close_page'];

let seq = 0;
function transcript(...records) {
  const transcriptPath = path.join(tmpDir, `t${seq++}.jsonl`);
  fs.writeFileSync(transcriptPath, records.map((r) => JSON.stringify(r)).join('\n'));
  return transcriptPath;
}
const typed = (text) => ({ type: 'user', message: { content: text } });
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } };
const plain = transcript(typed('check the referral screen'));

function run(input) {
  const res = spawnSync('bash', [HOOK_PATH], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(res.stderr, '');
  return res.stdout;
}
const call = (tool, extra = {}) => ({ tool_name: `mcp__chrome-devtools__${tool}`, tool_input: {}, session_id: 's1', transcript_path: plain, ...extra });

test('browser main-thread guard', async (t) => {
  await t.test('a main-thread click is denied with a reason naming browser-verifier', () => {
    const out = JSON.parse(run(call('click'))).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /browser-verifier/);
  });

  await t.test('a click with an agent_id is silent', () => {
    assert.equal(run(call('click', { agent_id: 'a1' })), '');
  });

  await t.test('every read tool is silent on the main thread', () => {
    for (const tool of READ_TOOLS) assert.equal(run(call(tool)), '', tool);
  });

  await t.test('a typed [browser-inline: <why>] turn lifts it, through a later tool_result turn', () => {
    const escaped = transcript(typed('[browser-inline: x]'));
    assert.equal(run(call('click', { transcript_path: escaped })), '');
    const escapedThenResult = transcript(typed('[browser-inline: x]'), toolResult);
    assert.equal(run(call('click', { transcript_path: escapedThenResult })), '');
  });

  await t.test('a compaction summary carrying the phrase does not lift it', () => {
    const summary = transcript({ type: 'user', isCompactSummary: true, message: { content: 'Earlier the user typed [browser-inline: x]' } });
    assert.equal(JSON.parse(run(call('click', { transcript_path: summary }))).hookSpecificOutput.permissionDecision, 'deny');
  });

  await t.test('{} and empty stdin exit 0 with no output', () => {
    assert.equal(run({}), '');
    assert.equal(run(''), '');
  });

  await t.test('a Read tool name exits 0 with no output', () => {
    assert.equal(run({ tool_name: 'Read', tool_input: { file_path: '/x' }, transcript_path: plain }), '');
  });
});
