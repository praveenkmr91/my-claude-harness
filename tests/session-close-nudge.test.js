'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'session-close-nudge.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-close-nudge-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const user = (content) => ({ type: 'user', message: { content } });
const reply = (text) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const compaction = (extra = {}) => ({
  type: 'system',
  subtype: 'compact_boundary',
  isSidechain: false,
  compactMetadata: { trigger: 'manual', preTokens: 348819 },
  ...extra,
});
const nudge = (count) =>
  `This session has compacted ${count} times. At the next stopping point: save state with /remember:remember, close it and start a new session.`;

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

test('session close nudge', async (t) => {
  await t.test('tells the user to close the session after the second compaction', () => {
    const { first } = run([user('go'), compaction(), reply('one'), compaction(), reply('two')]);
    assert.equal(first.status, 0);
    assert.equal(JSON.parse(first.stdout).systemMessage, nudge(2));
  });

  await t.test('stays quiet when the same transcript stops again', () => {
    const { again } = run([user('go'), compaction(), compaction(), reply('two')]);
    assert.equal(again().stdout, '');
  });

  await t.test('speaks again when a third compaction lands', () => {
    const stop = session();
    const twice = [user('go'), compaction(), compaction(), reply('two')];
    assert.equal(JSON.parse(stop(twice).stdout).systemMessage, nudge(2));
    assert.equal(JSON.parse(stop([...twice, compaction(), reply('three')]).stdout).systemMessage, nudge(3));
  });

  await t.test('stays quiet after one compaction', () => {
    const { first } = run([user('go'), compaction(), reply('one')]);
    assert.equal(first.stdout, '');
  });

  await t.test('does not count sidechain compactions', () => {
    const { first } = run([user('go'), compaction({ isSidechain: true }), compaction({ isSidechain: true }), reply('two')]);
    assert.equal(first.stdout, '');
  });

  await t.test('does not count the record text quoted inside an assistant message', () => {
    const quoted = reply(`The record looks like ${JSON.stringify(compaction())}`);
    const { first } = run([user('go'), quoted, quoted]);
    assert.equal(first.stdout, '');
  });

  await t.test('stays quiet on a subagent stop', () => {
    const { first } = run([user('go'), compaction(), compaction(), reply('two')], { agent_id: 'a1' });
    assert.equal(first.stdout, '');
  });

  await t.test('exits 0 and silent without a session id', () => {
    const { first } = run([user('go'), compaction(), compaction(), reply('two')], { session_id: undefined });
    assert.equal(first.status, 0);
    assert.equal(first.stdout, '');
  });

  await t.test('exits 0 and silent on empty input', () => {
    const empty = spawnSync('bash', [HOOK_PATH], { input: '', encoding: 'utf8' });
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout, '');
  });

  await t.test('exits 0 and silent on a missing transcript', () => {
    const missing = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ session_id: 'x', transcript_path: path.join(tmpDir, 'none.jsonl') }), encoding: 'utf8' });
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout, '');
  });
});
