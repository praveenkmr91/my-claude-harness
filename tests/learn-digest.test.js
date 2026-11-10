'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'automation', 'learn-digest.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-digest-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const typed = (text, extra = {}) => ({ type: 'user', message: { content: text }, ...extra });
const said = (text, extra = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
const skillCall = (skill) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
const toolResult = (content) => ({ type: 'user', message: { content: [{ type: 'tool_result', content }] } });
const LEARN_COMMAND = typed('<command-message>learn</command-message>\n<command-name>/learn</command-name>');
const FOUR_PROMPTS = ['one', 'two', 'three', 'four'].map((text) => typed(`prompt ${text}`));

let seq = 0;
const freshDir = (label) => fs.mkdtempSync(path.join(tmpDir, `${label}-${seq++}-`));

// Project dir names start with `-` like the real ones, so a file argument missing its `--` shows up here.
function session(root, id, records, { project = '-Users-x-repo', ageSeconds = 0 } = {}) {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

function run(root, cursor, out, env = {}) {
  return spawnSync('bash', [SCRIPT, root, cursor, out], { encoding: 'utf8', env: { ...process.env, ...env } });
}

const digests = (out) => fs.readdirSync(out).filter((name) => name.endsWith('.md')).sort();
const read = (out, id) => fs.readFileSync(path.join(out, `${id}.md`), 'utf8').split('\n').slice(0, -1);
const NO_CURSOR = path.join(tmpDir, 'no-such-cursor');

const keptRecords = [
  typed('first prompt'),
  said('a'.repeat(500), { cwd: '/work/repo-one' }),
  skillCall('verify'),
  toolResult('tool output that never reaches the digest'),
  typed('before <private>line one\nline two\nline three SECRET</private> after', { cwd: '/work/elsewhere' }),
  typed('p'.repeat(600)),
  typed('naïve café 你好'),
  said('second answer'),
];

test('keeps a session, skips learn runs and short sessions, truncates and orders records', () => {
  const root = freshDir('root');
  const out = path.join(freshDir('out'), 'digest');
  const kept = session(root, 'kept', [typed('no cwd on this record'), ...keptRecords]);
  const quoted = session(root, 'quoted', [
    ...FOUR_PROMPTS,
    toolResult('the docs say <command-name>/learn</command-name> starts a lesson'),
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: '<command-name>/learn</command-name>' }] }] } },
  ]);
  session(root, 'skill-learn', [...FOUR_PROMPTS, skillCall('learn')]);
  session(root, 'typed-learn', [...FOUR_PROMPTS, LEARN_COMMAND]);
  session(root, 'two-prompts', [typed('only'), said('reply'), typed('two')]);
  session(root, 'other-skill', [...FOUR_PROMPTS, skillCall('learner')]);
  session(root, 'agent-x', [...FOUR_PROMPTS], { project: path.join('-Users-x-repo', 'sess', 'subagents') });

  const result = run(root, NO_CURSOR, out);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(digests(out), ['kept.md', 'other-skill.md', 'quoted.md']);
  assert.equal(fs.existsSync(path.join(out, 'skipped.txt')), false);
  assert.deepEqual(read(out, 'kept'), [
    `# ${kept} · repo /work/repo-one`,
    'user: no cwd on this record',
    'user: first prompt',
    `assistant: ${'a'.repeat(400)}`,
    'user: before after',
    `user: ${'p'.repeat(500)}`,
    'user: naïve café 你好',
    'assistant: second answer',
  ]);
  assert.equal(read(out, 'quoted')[0], `# ${quoted} · repo `);
});

test('first record carrying a cwd names the repo even when later records differ', () => {
  const root = freshDir('root');
  const out = path.join(freshDir('out'), 'digest');
  const file = session(root, 'cwd', [typed('one'), typed('two', { cwd: '/work/first' }), typed('three', { cwd: '/work/second' })]);

  assert.equal(run(root, NO_CURSOR, out).status, 0);
  assert.equal(read(out, 'cwd')[0], `# ${file} · repo /work/first`);
});

test('a private span is stripped across lines and leaves no trace of its content', () => {
  const root = freshDir('root');
  const out = path.join(freshDir('out'), 'digest');
  session(root, 'spans', [typed('keep one <private>alpha\nbeta\ngamma</private> keep on'), typed('keep two'), typed('keep three')]);

  assert.equal(run(root, NO_CURSOR, out).status, 0);
  const body = fs.readFileSync(path.join(out, 'spans.md'), 'utf8');
  assert.doesNotMatch(body, /alpha|beta|gamma|<private>/);
  assert.match(body, /user: keep one keep on\n/);
});

test('a file over its cap keeps the tail with the cut named on line 2', () => {
  const root = freshDir('root');
  const out = path.join(freshDir('out'), 'digest');
  const records = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word) => typed(`${word} ${'x'.repeat(80)}`));
  session(root, 'long', records);

  assert.equal(run(root, NO_CURSOR, out, { LEARN_DIGEST_FILE_CAP: '400' }).status, 0);
  const lines = read(out, 'long');
  assert.match(lines[0], /^# .*long\.jsonl · repo $/);
  assert.match(lines[1], /^\[head cut: first \d+ of 6 records dropped to fit the 400-byte file cap\]$/);
  assert.match(lines[lines.length - 1], /^user: foxtrot /);
  assert.doesNotMatch(lines.join('\n'), /alpha/);
  assert.ok(fs.statSync(path.join(out, 'long.md')).size <= 400);
});

test('a file under its cap has no cut line', () => {
  const root = freshDir('root');
  const out = path.join(freshDir('out'), 'digest');
  session(root, 'short', FOUR_PROMPTS);

  assert.equal(run(root, NO_CURSOR, out).status, 0);
  assert.equal(read(out, 'short').some((line) => line.startsWith('[head cut')), false);
});

test('past the set cap the oldest sessions are kept and the newer ones are listed oldest first', () => {
  const root = freshDir('root');
  const probeOut = path.join(freshDir('out'), 'digest');
  const out = path.join(freshDir('out'), 'digest');
  const newest = session(root, 'aaa-newest', FOUR_PROMPTS, { ageSeconds: 300 });
  const middle = session(root, 'bbb-middle', FOUR_PROMPTS, { ageSeconds: 600 });
  const older = session(root, 'ccc-older', FOUR_PROMPTS, { ageSeconds: 900 });
  const oldest = session(root, 'ddd-oldest', FOUR_PROMPTS, { ageSeconds: 1200 });
  session(root, 'eee-learn', [...FOUR_PROMPTS, skillCall('learn')], { ageSeconds: 1500 });

  assert.equal(run(root, NO_CURSOR, probeOut).status, 0);
  const one = fs.statSync(path.join(probeOut, 'aaa-newest.md')).size;
  assert.equal(fs.existsSync(path.join(probeOut, 'skipped.txt')), false);
  assert.equal(fs.existsSync(path.join(probeOut, 'kept-until')), false);

  const result = run(root, NO_CURSOR, out, { LEARN_DIGEST_SET_CAP: String(one + 1) });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(digests(out), ['ccc-older.md', 'ddd-oldest.md']);
  assert.equal(fs.readFileSync(path.join(out, 'skipped.txt'), 'utf8'), `${middle}\n${newest}\n`);
  assert.equal(read(out, 'ddd-oldest')[0], `# ${oldest} · repo `);
  const keptUntil = fs.statSync(path.join(out, 'kept-until'), { bigint: true });
  assert.equal(keptUntil.size, 0n);
  assert.equal(keptUntil.mtimeNs, fs.statSync(older, { bigint: true }).mtimeNs);
});

test('sessions tied with the last kept one are kept past the cap', () => {
  const root = freshDir('root');
  const out = path.join(freshDir('out'), 'digest');
  const first = session(root, 'aaa-first', FOUR_PROMPTS);
  const second = session(root, 'bbb-second', FOUR_PROMPTS);
  const tied = new Date(Date.now() - 600 * 1000);
  for (const file of [first, second]) fs.utimesSync(file, tied, tied);

  const result = run(root, NO_CURSOR, out, { LEARN_DIGEST_SET_CAP: '1' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(digests(out), ['aaa-first.md', 'bbb-second.md']);
  assert.equal(fs.existsSync(path.join(out, 'skipped.txt')), false);
  assert.equal(fs.existsSync(path.join(out, 'kept-until')), false);
});

test('no cursor file reads the last 7 days; a cursor file reads what is newer than it', () => {
  const root = freshDir('root');
  const fresh = session(root, 'fresh', FOUR_PROMPTS, { ageSeconds: 600 });
  session(root, 'hours', FOUR_PROMPTS, { ageSeconds: 7200 });
  session(root, 'ancient', FOUR_PROMPTS, { ageSeconds: 10 * 86400 });
  const cursor = path.join(freshDir('cursor'), 'cursor');
  fs.writeFileSync(cursor, '');
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(cursor, hourAgo, hourAgo);

  const noCursorOut = path.join(freshDir('out'), 'digest');
  const cursorOut = path.join(freshDir('out'), 'digest');
  assert.equal(run(root, NO_CURSOR, noCursorOut).status, 0);
  assert.equal(run(root, cursor, cursorOut).status, 0);

  assert.deepEqual(digests(noCursorOut), ['fresh.md', 'hours.md']);
  assert.deepEqual(digests(cursorOut), ['fresh.md']);
  assert.equal(read(cursorOut, 'fresh')[0], `# ${fresh} · repo `);
});

test('a root with no matching transcripts exits 0 and leaves the out dir empty, stale files gone', () => {
  const root = freshDir('root');
  const out = freshDir('out');
  fs.writeFileSync(path.join(out, 'stale.md'), 'left over');
  fs.writeFileSync(path.join(out, 'skipped.txt'), '/old\n');
  session(root, 'ancient', FOUR_PROMPTS, { ageSeconds: 10 * 86400 });

  const result = run(root, NO_CURSOR, out);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('an out dir that does not exist yet is created', () => {
  const out = path.join(freshDir('out'), 'nested', 'digest');

  assert.equal(run(freshDir('root'), NO_CURSOR, out).status, 0);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('missing arguments and a missing root fail loudly', () => {
  const noArgs = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /usage/);

  const missingRoot = run(path.join(tmpDir, 'absent'), NO_CURSOR, path.join(freshDir('out'), 'digest'));
  assert.equal(missingRoot.status, 1);
  assert.match(missingRoot.stderr, /projects root not found/);
});
