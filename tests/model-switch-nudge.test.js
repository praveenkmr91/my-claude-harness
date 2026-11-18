'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'model-switch-nudge.sh');
const PLAN = '/Users/me/.claude/plans/checkout-rework.md';
const FABLE = 'claude-fable-5-2';
const OPUS = 'claude-opus-5-5';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-switch-nudge-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const user = (content) => ({ type: 'user', message: { content } });
const planEdit = (model, file = PLAN) => ({
  type: 'assistant',
  message: { model, content: [{ type: 'tool_use', id: 'tu', name: 'Write', input: { file_path: file } }] },
});
const reply = (model, text) => ({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } });
const ASK = 'Plan is in the file.\n\nSo: type "implement" to start chunk 1.';
const OPEN_ITEMS = 'Plan is in the file.\n\nSo: two open items above need your answer first.';

let seq = 0;
function session(extra = {}) {
  const id = `s${seq++}`;
  const home = path.join(tmpDir, id);
  fs.mkdirSync(home);
  const file = path.join(home, 't.jsonl');
  return (entries) => {
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
    const input = JSON.stringify({ session_id: id, transcript_path: file, ...extra });
    return spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8', env: { ...process.env, HOME: home } });
  };
}

function run(entries, extra) {
  const stop = session(extra);
  return { first: stop(entries), again: () => stop(entries) };
}

test('model switch nudge', async (t) => {
  await t.test('tells the user to switch when a Fable reply asks for the approval word on an unapproved plan', () => {
    const { first } = run([user('plan it'), planEdit(FABLE), reply(FABLE, ASK)]);
    assert.equal(first.status, 0);
    const message = JSON.parse(first.stdout).systemMessage;
    assert.match(message, /checkout-rework\.md/);
    assert.match(message, /\/model opus/);
  });

  await t.test('stays quiet on the second ask for the same plan', () => {
    const { again } = run([user('plan it'), planEdit(FABLE), reply(FABLE, ASK)]);
    assert.equal(again().stdout, '');
  });

  await t.test('stays quiet when the same ask comes from an Opus session', () => {
    const { first } = run([user('plan it'), planEdit(OPUS), reply(OPUS, ASK)]);
    assert.equal(first.status, 0);
    assert.equal(first.stdout, '');
  });

  await t.test('stays quiet while the reply still closes on open items', () => {
    const { first } = run([user('plan it'), planEdit(FABLE), reply(FABLE, OPEN_ITEMS)]);
    assert.equal(first.stdout, '');
  });

  await t.test('stays quiet when the closing line only mentions implementing in prose', () => {
    const { first } = run([user('plan it'), planEdit(FABLE), reply(FABLE, 'Plan is in the file.\n\nSo: two open items need your answer before I implement or build anything.')]);
    assert.equal(first.stdout, '');
  });

  await t.test('fires on a quoted build as the approval word', () => {
    const { first } = run([user('plan it'), planEdit(FABLE), reply(FABLE, 'Plan is in the file.\n\nSo: reply `build` when ready.')]);
    assert.match(JSON.parse(first.stdout).systemMessage, /\/model opus/);
  });

  await t.test('fires again for a second plan in the same session', () => {
    const stop = session();
    const firstPlan = [user('plan it'), planEdit(FABLE), reply(FABLE, ASK)];
    assert.match(stop(firstPlan).stdout, /checkout-rework\.md/);
    const secondPlan = [...firstPlan, user('implement'), reply(FABLE, 'Built.'), user('plan the next one'), planEdit(FABLE, '/Users/me/.claude/plans/search-filters.md'), reply(FABLE, ASK)];
    assert.match(stop(secondPlan).stdout, /search-filters\.md/);
  });

  await t.test('reads the ask from the hook input when the transcript has not caught up', () => {
    const lagging = [user('plan it'), reply(FABLE, 'Drafting the plan now.'), planEdit(FABLE)];
    assert.equal(run(lagging).first.stdout, '');
    assert.match(run(lagging, { last_assistant_message: ASK }).first.stdout, /\/model opus/);
  });

  await t.test('stays quiet after a switch to Opus and fires after a switch back to Fable', () => {
    const drafted = [user('plan it'), planEdit(FABLE), reply(FABLE, OPEN_ITEMS), user('answers'), reply(OPUS, ASK)];
    assert.equal(run(drafted).first.stdout, '');
    assert.match(run([...drafted, user('one more question'), reply(FABLE, ASK)]).first.stdout, /\/model opus/);
  });

  await t.test('stays quiet once the plan is approved', () => {
    const { first } = run([user('plan it'), planEdit(FABLE), reply(FABLE, ASK), user('implement'), reply(FABLE, 'Chunk 1 dispatched; type "implement" for chunk 2 after it lands.')]);
    assert.equal(first.stdout, '');
  });

  await t.test('stays quiet with no plan edit in the transcript', () => {
    const { first } = run([user('how do I implement this?'), reply(FABLE, ASK)]);
    assert.equal(first.stdout, '');
  });

  await t.test('stays quiet on a subagent stop', () => {
    const { first } = run([user('plan it'), planEdit(FABLE), reply(FABLE, ASK)], { agent_id: 'a1' });
    assert.equal(first.stdout, '');
  });

  await t.test('exits 0 and silent on empty input and on a missing transcript', () => {
    const empty = spawnSync('bash', [HOOK_PATH], { input: '', encoding: 'utf8' });
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout, '');
    const missing = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ session_id: 'x', transcript_path: path.join(tmpDir, 'none.jsonl') }), encoding: 'utf8' });
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout, '');
  });
});
