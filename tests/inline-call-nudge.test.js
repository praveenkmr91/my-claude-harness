'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'inline-call-nudge.sh');
const SETTINGS_PATH = path.join(ROOT, 'settings.json');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-call-nudge-'));
const userLine = (content) => ({ type: 'user', message: { content } });
const assistantLine = (text) => ({ type: 'assistant', message: { model: 'claude-opus-5', content: text ? [{ type: 'text', text }] : [] } });
const transcripts = {};
for (const [name, entries] of Object.entries({
  typed: [userLine('where is the retry logic?'), assistantLine()],
  skipNoReason: [userLine('where is the retry logic?'), assistantLine('direct: continue —')],
  skipBare: [userLine('where is the retry logic?'), assistantLine('direct: continue')],
  skipReason: [userLine('where is the retry logic?'), assistantLine('direct: continue — the file path is known')],
})) {
  transcripts[name] = path.join(tmpDir, `${name}.jsonl`);
  fs.writeFileSync(transcripts[name], entries.map((e) => JSON.stringify(e)).join('\n'));
}

let seq = 0;
const RUN = crypto.randomBytes(4).toString('hex');
const SESSION_PREFIX = `inline-test-${process.pid}`;
const newSession = () => `${SESSION_PREFIX}-${RUN}-${seq++}`;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const f of fs.readdirSync('/tmp')) {
    if (f.startsWith(`claude-inline-calls-${SESSION_PREFIX}`)) fs.rmSync(path.join('/tmp', f), { force: true });
  }
});

function run(payload, { mode, raw } = {}) {
  const input = raw === undefined ? JSON.stringify(payload) : raw;
  const res = spawnSync('bash', [HOOK_PATH, ...(mode ? [mode] : [])], { input, encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr };
}

const step = (tool_name, tool_input, extra) => ({ tool_name, tool_input, ...extra });
const read = (extra) => step('Read', { file_path: '/tmp/a.ts' }, extra);
const bash = (command, extra) => step('Bash', { command }, extra);
const edit = (extra) => step('Edit', { file_path: '/tmp/a.ts' }, extra);
const agent = () => step('Agent', { subagent_type: 'Explore' });
const sendMessage = () => step('SendMessage', { to: 'agent-1' });
const resetOnPrompt = (prompt) => ({ mode: 'reset', hook_event_name: 'UserPromptSubmit', prompt });

function play(steps, { transcript = 'typed', sessionId = newSession() } = {}) {
  return steps.map(({ mode, ...rest }) => run({
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    transcript_path: transcripts[transcript],
    ...rest,
  }, { mode }));
}

function assertFiresAt(results, fireAt) {
  results.forEach(({ code, stderr }, i) => {
    if (fireAt.includes(i)) {
      assert.equal(code, 2, `step ${i} should fire`);
      assert.match(stderr, /direct lookups/);
    } else {
      assert.equal(code, 0, `step ${i} should be quiet`);
      assert.equal(stderr, '');
    }
  });
}

const repeat = (n, make) => Array.from({ length: n }, make);

test('inline call nudge — fires', async (t) => {
  await t.test('on the 4th of four Reads', () => {
    assertFiresAt(play(repeat(4, () => read())), [3]);
  });

  await t.test('on the 4th when the 4th is a grep Bash', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('grep -rn foo src')]), [3]);
  });

  await t.test('on the 4th when the 4th is a cd-prefixed grep Bash', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('cd /repo && grep foo src')]), [3]);
  });

  await t.test('on the 4th when the 4th is a grep Bash after `cd <dir>;`', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('cd /repo; grep foo src')]), [3]);
  });

  await t.test('on the 4th when the 4th is a for loop over grep', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('cd /repo; for f in a.ts b.ts; do echo "== $f"; grep -n foo $f; done')]), [3]);
  });

  await t.test('on the 4th when the 4th is an echo-labelled grep count', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('cd /repo; echo "files: $(grep -rl foo src | wc -l)"')]), [3]);
  });

  await t.test('on the 4th when the 4th is a git status Bash', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('git -C ~/.claude status')]), [3]);
  });

  await t.test('on the 4th when the 4th arrives as PostToolUseFailure', () => {
    assertFiresAt(play([...repeat(3, () => read()), read({ hook_event_name: 'PostToolUseFailure' })]), [3]);
  });

  await t.test('on the 4th and 8th of eight Reads, and only those', () => {
    const results = play(repeat(8, () => read()));
    assertFiresAt(results, [3, 7]);
    assert.match(results[3].stderr, /made 4 direct lookups/);
    assert.match(results[7].stderr, /made 8 direct lookups/);
  });

  await t.test('past a `direct: continue` with nothing after the dash', () => {
    assertFiresAt(play(repeat(4, () => read()), { transcript: 'skipNoReason' }), [3]);
  });

  await t.test('past a bare `direct: continue`', () => {
    assertFiresAt(play(repeat(4, () => read()), { transcript: 'skipBare' }), [3]);
  });

  await t.test('on the 4th Read after an injected task-notification prompt, which does not reset', () => {
    const steps = [...repeat(3, () => read()), resetOnPrompt('<task-notification>build finished</task-notification>'), read()];
    assertFiresAt(play(steps), [4]);
  });

  await t.test('on a Read after a build Bash, which neither counts nor resets', () => {
    const steps = [...repeat(3, () => read()), bash('pnpm lint 2>&1 | tail -20'), read()];
    assertFiresAt(play(steps), [4]);
  });
});

test('inline call nudge — quiet', async (t) => {
  await t.test('three Reads', () => {
    assertFiresAt(play(repeat(3, () => read())), []);
  });

  await t.test('two Reads, an Agent dispatch, two Reads', () => {
    assertFiresAt(play([read(), read(), agent(), read(), read()]), []);
  });

  await t.test('two Reads, an Edit, two Reads', () => {
    assertFiresAt(play([read(), read(), edit(), read(), read()]), []);
  });

  await t.test('two Reads, a SendMessage, two Reads', () => {
    assertFiresAt(play([read(), read(), sendMessage(), read(), read()]), []);
  });

  await t.test('two Reads, a typed prompt, two Reads', () => {
    assertFiresAt(play([read(), read(), resetOnPrompt('do it'), read(), read()]), []);
  });

  await t.test('three Reads then a build Bash piped to tail', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('pnpm lint 2>&1 | tail -20')]), []);
  });

  await t.test('three Reads then an install Bash after `cd <dir>;`', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('cd /repo; pnpm install')]), []);
  });

  await t.test('three Reads then a for loop over node', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('for f in a.js b.js; do node $f; done')]), []);
  });

  await t.test('three Reads then an echo-labelled lint Bash', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('echo "== lint"; pnpm lint')]), []);
  });

  await t.test('three Reads then a test Bash piped to head', () => {
    assertFiresAt(play([...repeat(3, () => read()), bash('node --test tests/x.test.js | head -5')]), []);
  });

  await t.test('four Reads with `direct: continue — <why>` since the prompt', () => {
    assertFiresAt(play(repeat(4, () => read()), { transcript: 'skipReason' }), []);
  });

  await t.test('four Reads from a subagent', () => {
    assertFiresAt(play(repeat(4, () => read({ agent_id: 'agent-1' }))), []);
  });

  await t.test('four Edits', () => {
    assertFiresAt(play(repeat(4, () => edit())), []);
  });
});

test('inline call nudge — fails open', async (t) => {
  const counterFile = '/tmp/claude-inline-calls-';

  await t.test('empty stdin', () => {
    assert.deepEqual(run(undefined, { raw: '' }), { code: 0, stderr: '' });
    assert.equal(fs.existsSync(counterFile), false);
  });

  await t.test('empty object', () => {
    assert.deepEqual(run({}), { code: 0, stderr: '' });
    assert.equal(fs.existsSync(counterFile), false);
  });

  await t.test('no session id', () => {
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(run({ ...read(), transcript_path: transcripts.typed }), { code: 0, stderr: '' });
    }
    assert.equal(fs.existsSync(counterFile), false);
  });

  await t.test('unreadable transcript on the 4th Read', () => {
    const steps = repeat(4, () => read({ transcript_path: '/nonexistent' }));
    assertFiresAt(play(steps), []);
  });
});

test('inline call nudge — settings wiring', () => {
  const hooks = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')).hooks;
  const commandsFor = (event, matcher) => hooks[event]
    .filter((group) => matcher === undefined || group.matcher === matcher)
    .flatMap((group) => group.hooks.map((h) => h.command));
  const lookupMatcher = 'Read|Grep|Glob|Bash';
  const resetMatcher = 'Agent|SendMessage|Edit|Write|NotebookEdit';

  assert.ok(commandsFor('PostToolUse', lookupMatcher).some((c) => /inline-call-nudge\.sh$/.test(c)));
  assert.ok(commandsFor('PostToolUseFailure', lookupMatcher).some((c) => /inline-call-nudge\.sh$/.test(c)));
  assert.ok(commandsFor('PostToolUse', resetMatcher).some((c) => /inline-call-nudge\.sh reset$/.test(c)));
  assert.ok(commandsFor('UserPromptSubmit').some((c) => /inline-call-nudge\.sh reset$/.test(c)));
});
