'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('review-lens-nudge: names lenses on a code edit, once per turn and lens set', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lens-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'api.ts'), 'p.catch(() => null);\n');
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'build it' } }));
  const sessionId = `harness-lens-${process.pid}-${Date.now()}`;
  const edit = (file) => execFileSync('bash', [path.join(ROOT, 'hooks', 'review-lens-nudge.sh')], {
    input: JSON.stringify({ tool_input: { file_path: path.join(repo, file) }, cwd: repo, transcript_path: transcript, session_id: sessionId }),
    encoding: 'utf8',
  });
  assert.match(JSON.parse(edit('api.ts')).hookSpecificOutput.additionalContext, /Review lenses for this change: .*silent-failure-hunter/);
  assert.equal(edit('api.ts'), '');
  assert.equal(edit('README.md'), '');
  fs.appendFileSync(transcript, '\n' + JSON.stringify({ type: 'user', message: { content: 'next' } }));
  assert.match(edit('api.ts'), /Review lenses/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(`/tmp/claude-review-lenses-${sessionId}`, { force: true });
});

test('review-lens-nudge: scores the edited file\'s repo, not the payload cwd', () => {
  // Under the pre-commit hook git exports GIT_INDEX_FILE etc.; inherited, they point the scratch repos at ~/.claude's index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lens-')));
  const sessionIds = [];
  const lensesFor = ({ cwd, file }) => {
    const sessionId = `harness-lens-${process.pid}-${Date.now()}-${sessionIds.length}`;
    sessionIds.push(sessionId);
    const out = execFileSync('bash', [path.join(ROOT, 'hooks', 'review-lens-nudge.sh')], {
      input: JSON.stringify({ tool_input: { file_path: file }, cwd, session_id: sessionId }),
      encoding: 'utf8',
      env,
    });
    return JSON.parse(out).hookSpecificOutput.additionalContext.match(/Review lenses for this change: (.*?)\. Before/)[1];
  };
  const dirtyRepo = (name, file, source) => {
    const repo = path.join(home, name);
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    fs.writeFileSync(path.join(repo, file), source);
    return path.join(repo, file);
  };
  const tsx = dirtyRepo('a', 'view.tsx', 'export const View = () => <div />;\n');
  const ts = dirtyRepo('b', 'api.ts', 'p.catch(() => null);\n');

  try {
    assert.match(lensesFor({ cwd: path.dirname(tsx), file: tsx }), /react-best-practices/);
    const fromOtherRepo = lensesFor({ cwd: path.dirname(tsx), file: ts });
    assert.doesNotMatch(fromOtherRepo, /react-best-practices/);
    assert.equal(lensesFor({ cwd: path.dirname(ts), file: ts }), fromOtherRepo);
    assert.equal(execFileSync('bash', [path.join(ROOT, 'hooks', 'review-lens-nudge.sh')], { input: '', encoding: 'utf8', env }), '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    for (const sessionId of sessionIds) fs.rmSync(`/tmp/claude-review-lenses-${sessionId}`, { force: true });
  }
});

function nudgeSession() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lens-')));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  const transcript = path.join(home, 't.jsonl');
  const sessionId = `harness-lens-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stamp = (seconds) => new Date(Date.UTC(2099, 0, 1, 0, 0, seconds)).toISOString();
  let clock = 0;
  const append = (record) => fs.appendFileSync(transcript, `${JSON.stringify({ timestamp: stamp(clock++), ...record })}\n`);
  append({ type: 'user', message: { content: 'build it' } });
  return {
    write(name, lines) {
      const content = Array.from({ length: lines }, (_, i) => (i === 0 ? 'p.catch(() => null);' : `export const v${i} = ${i};`)).join('\n') + '\n';
      fs.writeFileSync(path.join(repo, name), content);
      append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `w-${name}`, name: 'Write', input: { file_path: path.join(repo, name), content } }] } });
      return path.join(repo, name);
    },
    nudge(file, extra = {}) {
      const out = execFileSync('bash', [path.join(ROOT, 'hooks', 'review-lens-nudge.sh')], {
        input: JSON.stringify({ tool_input: { file_path: file }, cwd: repo, transcript_path: transcript, session_id: sessionId, ...extra }),
        encoding: 'utf8',
        env,
      });
      return out === '' ? '' : JSON.parse(out).hookSpecificOutput.additionalContext;
    },
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(`/tmp/claude-review-lenses-${sessionId}`, { force: true });
    },
  };
}

const PLAIN_NUDGE = /^Review lenses for this change: [\w, -]+\. Before claiming done or asking to commit, give each a reply line `<lens>: N findings` or `<lens>: skip — <reason>` \(hand pass first, agent only on a lead\)\.$/;

test('review-lens-nudge: names the required members when unreviewed lines pass the floor', () => {
  const session = nudgeSession();
  try {
    const text = session.nudge(session.write('api.ts', 30));
    assert.match(text, /^Review lenses for this change: .*silent-failure-hunter.*\. Before/);
    assert.match(text, / Required members: code-reviewer, silent-failure-hunter\. Run each as an agent with an `effort` before a done-claim; a typed line does not count for them\.$/);
  } finally {
    session.cleanup();
  }
});

test('review-lens-nudge: a subagent payload keeps the text without the required members', () => {
  const session = nudgeSession();
  try {
    const text = session.nudge(session.write('api.ts', 30), { agent_id: 'a1' });
    assert.match(text, PLAIN_NUDGE);
    assert.match(text, /silent-failure-hunter/);
  } finally {
    session.cleanup();
  }
});

test('review-lens-nudge: under the floor the text is the existing one', () => {
  const session = nudgeSession();
  try {
    assert.match(session.nudge(session.write('api.ts', 3)), PLAIN_NUDGE);
  } finally {
    session.cleanup();
  }
});

test('review-lens-nudge: a 200-line write names the four Big members in the required members', () => {
  const session = nudgeSession();
  try {
    const text = session.nudge(session.write('api.ts', 200));
    assert.match(text, / Required members: code-reviewer, silent-failure-hunter, type-design-analyzer, reuse-analyzer, placement-analyzer\. Run each as an agent/);
  } finally {
    session.cleanup();
  }
});

test('review-lens-nudge: the same key stays silent, and crossing the floor nudges again', () => {
  const session = nudgeSession();
  try {
    const small = session.write('api.ts', 3);
    assert.match(session.nudge(small), PLAIN_NUDGE);
    assert.equal(session.nudge(small), '');
    const big = session.write('more.ts', 30);
    assert.match(session.nudge(big), / Required members: code-reviewer, silent-failure-hunter\./);
    assert.equal(session.nudge(big), '');
  } finally {
    session.cleanup();
  }
});
