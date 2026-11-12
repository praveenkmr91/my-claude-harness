'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'inject-once.sh');
const SETTINGS_PATH = path.resolve(__dirname, '..', 'settings.json');

const OUTPUT_CEILING = 9800;

const flags = [];
let seq = 0;
const newSession = () => `inject-once-test-${process.pid}-${seq++}`;

test.after(() => {
  for (const flag of flags) fs.rmSync(flag, { force: true });
});

function run(doc, payload, pattern) {
  if (payload.session_id) flags.push(`/tmp/claude-inject-${doc}-${payload.session_id}-${payload.agent_id || 'main'}`);
  const args = pattern ? [HOOK_PATH, doc, pattern] : [HOOK_PATH, doc];
  const res = spawnSync('bash', args, { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

function injectOnceEntries() {
  const hooks = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')).hooks;
  return Object.values(hooks)
    .flatMap((groups) => groups.flatMap((group) => group.hooks.map((h) => h.command)))
    .filter((command) => /inject-once\.sh/.test(command))
    .map((command) => {
      const [, doc, pattern] = command.match(/inject-once\.sh (\S+)(?: '([^']*)')?$/);
      return { doc, pattern };
    });
}

const call = (sessionId, agentId) => ({ session_id: sessionId, ...(agentId && { agent_id: agentId }), tool_name: 'Agent', tool_input: {} });
const bash = (sessionId, toolInput) => ({ session_id: sessionId, tool_name: 'Bash', tool_input: toolInput });
const context = (out) => JSON.parse(out).hookSpecificOutput.additionalContext;

test('inject-once hook', async (t) => {
  const entries = injectOnceEntries();
  const externalIo = entries.filter((e) => e.doc === 'external-io.md' && e.pattern);
  const committing = entries.filter((e) => e.doc === 'committing.md' && e.pattern);

  await t.test('first call injects the named doc', () => {
    const out = context(run('subagent-tiers.md', call(newSession())));
    assert.match(out, /subagent-tiers\.md — injected once/);
    assert.match(out, /\| Explore \| Haiku always/);
  });

  await t.test('later calls in the same thread are silent', () => {
    const sid = newSession();
    run('subagent-tiers.md', call(sid));
    assert.equal(run('subagent-tiers.md', call(sid)), '');
  });

  await t.test('each subagent thread gets its own injection', () => {
    const sid = newSession();
    run('browser-verify.md', call(sid));
    assert.match(context(run('browser-verify.md', call(sid, 'agent-a'))), /browser-verify\.md — injected once/);
    assert.equal(run('browser-verify.md', call(sid, 'agent-a')), '');
  });

  await t.test('different docs flag independently', () => {
    const sid = newSession();
    run('subagent-tiers.md', call(sid));
    assert.match(context(run('browser-verify.md', call(sid))), /browser-verify\.md/);
  });

  await t.test('a path pattern skips non-matching files without spending the flag', () => {
    const sid = newSession();
    const read = (file) => ({ session_id: sid, tool_name: 'Read', tool_input: { file_path: file } });
    const sourceOnly = '[.](tsx?|jsx?)$';
    assert.equal(run('code-craft.md', read('/repo/docs/plan.md'), sourceOnly), '');
    assert.match(context(run('code-craft.md', read('/repo/src/app.tsx'), sourceOnly)), /code-craft\.md — injected once/);
    assert.equal(run('code-craft.md', read('/repo/src/other.ts'), sourceOnly), '');
  });

  await t.test('settings carries a pattern on both gh/curl entries and the git entry', () => {
    assert.equal(externalIo.length, 2);
    assert.equal(committing.length, 1);
  });

  await t.test('gh or curl as a command token injects external-io.md', () => {
    const commands = [
      'gh api repos/x',
      'curl -s https://example.com',
      'cd repo; gh pr list',
      'true && curl -s https://example.com',
      'echo {} | gh api repos/x --input -',
      '(gh api repos/x)',
      'echo $(gh api user)',
      'for r in a; do gh api repos/$r; done',
      'echo repos/x | xargs -n1 gh api',
      'GH_TOKEN=x gh api user',
    ];
    for (const { pattern } of externalIo) {
      for (const command of commands) {
        assert.match(context(run('external-io.md', bash(newSession(), { command }), pattern)), /external-io\.md — injected once/, command);
      }
    }
  });

  await t.test('no gh or curl token stays quiet without spending the flag', () => {
    const toolInputs = [{ command: 'cat github.md' }, { command: 'foo --gh x' }, { command: 'for k in a; do git log; done' }, {}];
    for (const { pattern } of externalIo) {
      for (const toolInput of toolInputs) {
        const sid = newSession();
        assert.equal(run('external-io.md', bash(sid, toolInput), pattern), '', JSON.stringify(toolInput));
        assert.match(context(run('external-io.md', bash(sid, { command: 'gh api repos/x' }), pattern)), /external-io\.md — injected once/);
      }
    }
  });

  await t.test('a git token injects committing.md, including behind an env prefix', () => {
    for (const { pattern } of committing) {
      for (const command of ['git status', 'GIT_INDEX_FILE=/tmp/i git read-tree HEAD']) {
        assert.match(context(run('committing.md', bash(newSession(), { command }), pattern)), /committing\.md — injected once/, command);
      }
    }
  });

  await t.test('no git token stays quiet without spending the flag', () => {
    const toolInputs = [{ command: 'cat github.md' }, { command: 'gitk --all' }, {}];
    for (const { pattern } of committing) {
      for (const toolInput of toolInputs) {
        const sid = newSession();
        assert.equal(run('committing.md', bash(sid, toolInput), pattern), '', JSON.stringify(toolInput));
        assert.match(context(run('committing.md', bash(sid, { command: 'git status' }), pattern)), /committing\.md — injected once/);
      }
    }
  });

  await t.test('one hook group holds both tier docs', () => {
    const groups = Object.values(JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')).hooks).flat();
    const tierGroups = groups.filter((group) => group.hooks.some((h) => /inject-once\.sh subagent-tiers\.md$/.test(h.command)));
    assert.equal(tierGroups.length, 1);
    assert.ok(tierGroups[0].hooks.some((h) => /inject-once\.sh subagent-tiers-enforcement\.md$/.test(h.command)));
  });

  await t.test('every wired doc injects under the hook output ceiling', () => {
    const patternInputs = [{ file_path: 'x.ts' }, { command: 'git status' }, { command: 'gh pr view 1' }];
    for (const { doc, pattern } of entries) {
      const outputs = (pattern ? patternInputs : [{}])
        .map((toolInput) => run(doc, { session_id: newSession(), tool_name: 'Bash', tool_input: toolInput }, pattern))
        .filter((out) => out !== '');
      assert.notEqual(outputs.length, 0, `${doc} injects nothing`);
      for (const out of outputs) {
        assert.ok(Buffer.byteLength(out) < OUTPUT_CEILING, `${doc} emits ${Buffer.byteLength(out)} bytes, ceiling ${OUTPUT_CEILING}`);
      }
    }
  });

  await t.test('racing hook processes on one session inject once', async () => {
    const sid = newSession();
    flags.push(`/tmp/claude-inject-external-io.md-${sid}-main`);
    const spawnRun = () => new Promise((resolve, reject) => {
      const child = spawn('bash', [HOOK_PATH, 'external-io.md', externalIo[0].pattern]);
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout }));
      child.stdin.end(JSON.stringify(bash(sid, { command: 'gh api repos/x' })));
    });
    const results = await Promise.all(Array.from({ length: 20 }, spawnRun));
    assert.ok(results.every((r) => r.status === 0));
    assert.equal(results.filter((r) => r.stdout !== '').length, 1);
  });

  await t.test('compaction resets the flag so the doc injects again, nudge counters kept', () => {
    const sid = newSession();
    const counter = `/tmp/claude-inline-calls-${sid}`;
    fs.writeFileSync(counter, '3');
    run('subagent-tiers.md', call(sid, 'agent-a'));
    const reset = spawnSync('bash', [path.resolve(__dirname, '..', 'hooks', 'reset-context-flags.sh')], { input: JSON.stringify({ session_id: sid }), encoding: 'utf8' });
    assert.equal(reset.status, 0);
    assert.match(context(run('subagent-tiers.md', call(sid, 'agent-a'))), /subagent-tiers\.md — injected once/);
    assert.ok(fs.existsSync(counter));
    fs.rmSync(counter);
  });

  await t.test("compaction clears the session's Hydrogen section flags only", () => {
    const sid = newSession();
    const otherSid = newSession();
    const hydrogenFlag = (session, section) => `/tmp/claude-hydrogen-ctx-${session}-${section}`;
    const ownFlags = [hydrogenFlag(sid, 'map'), hydrogenFlag(sid, 'workflows')];
    const otherFlag = hydrogenFlag(otherSid, 'map');
    for (const flag of [...ownFlags, otherFlag]) fs.writeFileSync(flag, '');
    flags.push(...ownFlags, otherFlag);
    const resetHook = path.resolve(__dirname, '..', 'hooks', 'reset-context-flags.sh');

    const noSession = spawnSync('bash', [resetHook], { input: '{}', encoding: 'utf8' });
    assert.equal(noSession.status, 0);
    assert.ok([...ownFlags, otherFlag].every((flag) => fs.existsSync(flag)));

    const reset = spawnSync('bash', [resetHook], { input: JSON.stringify({ session_id: sid }), encoding: 'utf8' });
    assert.equal(reset.status, 0);
    assert.deepEqual(ownFlags.filter((flag) => fs.existsSync(flag)), []);
    assert.ok(fs.existsSync(otherFlag));
  });

  await t.test('missing session id is silent', () => {
    assert.equal(run('subagent-tiers.md', { tool_name: 'Agent', tool_input: {} }), '');
  });
});
