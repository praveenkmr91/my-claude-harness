'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'inject-plan-mode.sh');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const SETTINGS_PATH = path.resolve(__dirname, '..', 'settings.json');

const OUTPUT_CEILING = 9800;

const flags = [];
let seq = 0;
const newSession = () => `inject-plan-mode-test-${process.pid}-${seq++}`;
const flagOf = (sessionId, doc) => `/tmp/claude-plan-mode-${sessionId}${doc ? `-${doc}` : ''}`;
const NAMED_DOC = 'browser-verify.md';

test.after(() => {
  for (const flag of flags) fs.rmSync(flag, { force: true });
});

function run(event, payload, doc) {
  if (payload.session_id) flags.push(flagOf(payload.session_id, doc));
  const res = spawnSync('bash', [HOOK_PATH, event, ...(doc ? [doc] : [])], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

const planEdit = (sessionId, file) => ({ session_id: sessionId, tool_name: 'Write', tool_input: { file_path: path.join(PLANS_DIR, file) } });

function injectPlanModeGroups() {
  const hooks = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')).hooks;
  return Object.values(hooks)
    .flat()
    .map((group) => group.hooks
      .map((h) => h.command.match(/inject-plan-mode\.sh (\S+)(?: (\S+))?$/))
      .filter(Boolean)
      .map(([, event, doc]) => ({ event, doc })))
    .filter((entries) => entries.length > 0);
}

const eventPayload = {
  PostToolUse: (sessionId) => ({ session_id: sessionId, tool_name: 'EnterPlanMode' }),
  PreToolUse: (sessionId) => planEdit(sessionId, 'x.md'),
  UserPromptSubmit: (sessionId) => ({ session_id: sessionId, permission_mode: 'plan' }),
};

test('inject-plan-mode hook', async (t) => {
  await t.test('a plan file edit injects plan-mode.md', () => {
    const out = run('PreToolUse', planEdit(newSession(), 'x.md'));
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Current instructions, never a journal/);
  });

  await t.test('a research file edit is silent and leaves no flag', () => {
    const sid = newSession();
    assert.equal(run('PreToolUse', planEdit(sid, 'x.research.md')), '');
    assert.equal(fs.existsSync(flagOf(sid)), false);
  });

  await t.test('empty input exits 0 with no output', () => {
    const res = spawnSync('bash', [HOOK_PATH, 'PreToolUse'], { input: '', encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  await t.test('a named doc is injected on each of the three events', () => {
    const named = fs.readFileSync(path.resolve(__dirname, '..', NAMED_DOC), 'utf8');
    for (const [event, payload] of Object.entries(eventPayload)) {
      const out = run(event, payload(newSession()), NAMED_DOC);
      assert.equal(event === 'UserPromptSubmit' ? out : JSON.parse(out).hookSpecificOutput.additionalContext, named, event);
    }
  });

  await t.test('a named doc fires once per session, independently of the default doc flag', () => {
    const sid = newSession();
    assert.match(JSON.parse(run('PreToolUse', planEdit(sid, 'x.md'))).hookSpecificOutput.additionalContext, /Current instructions, never a journal/);
    assert.notEqual(run('PreToolUse', planEdit(sid, 'x.md'), NAMED_DOC), '');
    assert.equal(run('PreToolUse', planEdit(sid, 'x.md'), NAMED_DOC), '');
    assert.equal(run('PreToolUse', planEdit(sid, 'x.md')), '');
  });

  await t.test('a named doc on a non-plan file is silent and leaves no flag', () => {
    const sid = newSession();
    const payload = { session_id: sid, tool_name: 'Write', tool_input: { file_path: '/tmp/not-a-plan.md' } };
    assert.equal(run('PreToolUse', payload, NAMED_DOC), '');
    assert.equal(fs.existsSync(flagOf(sid, NAMED_DOC)), false);
  });

  await t.test('a named doc on a prompt outside plan mode is silent and leaves no flag', () => {
    const sid = newSession();
    assert.equal(run('UserPromptSubmit', { session_id: sid, permission_mode: 'default' }, NAMED_DOC), '');
    assert.equal(fs.existsSync(flagOf(sid, NAMED_DOC)), false);
  });

  await t.test('a doc name with no file is silent and leaves no flag', () => {
    const sid = newSession();
    const missing = 'no-such-doc.md';
    assert.equal(run('PreToolUse', planEdit(sid, 'x.md'), missing), '');
    assert.equal(fs.existsSync(flagOf(sid, missing)), false);
  });

  await t.test('compaction resets both docs for its session only, so they inject again', () => {
    const sid = newSession();
    const other = newSession();
    for (const doc of [undefined, NAMED_DOC]) run('PreToolUse', planEdit(sid, 'x.md'), doc);
    run('PreToolUse', planEdit(other, 'x.md'), NAMED_DOC);
    const reset = spawnSync('bash', [path.resolve(__dirname, '..', 'hooks', 'reset-context-flags.sh')], { input: JSON.stringify({ session_id: sid }), encoding: 'utf8' });
    assert.equal(reset.status, 0);
    for (const doc of [undefined, NAMED_DOC]) assert.notEqual(run('PreToolUse', planEdit(sid, 'x.md'), doc), '', `${doc || 'plan-mode.md'} stays silent after compaction`);
    assert.equal(run('PreToolUse', planEdit(other, 'x.md'), NAMED_DOC), '', 'another session lost its flag');
  });

  await t.test('each event group holds both plan docs', () => {
    const groups = injectPlanModeGroups();
    assert.equal(groups.length, 3);
    for (const entries of groups) {
      const [{ event }] = entries;
      assert.deepEqual(entries.map((e) => e.doc), [undefined, 'plan-build.md'], event);
    }
  });

  await t.test('every wired plan doc injects under the hook output ceiling', () => {
    for (const { event, doc } of injectPlanModeGroups().flat()) {
      const out = run(event, eventPayload[event](newSession()), doc);
      const name = doc || 'plan-mode.md';
      assert.notEqual(out, '', `${name} injects nothing on ${event}`);
      assert.ok(Buffer.byteLength(out) < OUTPUT_CEILING, `${name} emits ${Buffer.byteLength(out)} bytes on ${event}, ceiling ${OUTPUT_CEILING}`);
    }
  });
});
