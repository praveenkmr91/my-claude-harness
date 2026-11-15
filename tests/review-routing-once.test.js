'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('review-routing: high-risk matches whole words, not substrings', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'routing-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'review-routing.md'), '');
  const repo = path.join(home, 'repo');
  for (const file of ['src/useAuth.ts', 'src/use-session.ts', 'src/recorder.ts', 'author-rules/x.md', 'styles/tokens.css', 'tooling/tokens/build.ts', 'docs/plans/app-token.md', 'src/session.spec.ts', 'auth-pkg/package.json', 'src/auth/mocks/handlers.ts', 'src/auth/tokens/refresh.ts']) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), '');
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sessionId = `harness-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify({ prompt: 'review', session_id: sessionId });
  const out = execFileSync('bash', [path.join(ROOT, 'hooks', 'review-routing-once.sh')], { input: payload, cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home } });
  const risk = out.match(/high-risk=(.*?) bulk=/)[1];
  assert.match(risk, /useAuth\.ts/);
  assert.match(risk, /use-session\.ts/);
  assert.match(risk, /src\/auth\/tokens\/refresh\.ts/);
  assert.doesNotMatch(risk, /recorder|author-rules|tokens\.css|tooling\/tokens|app-token|session\.spec|auth-pkg|mocks\/handlers/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(`/tmp/claude-review-routing-${sessionId}`, { force: true });
});

test('review-routing: subagent hand-backs do not trigger routing', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'routing-handback-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'review-routing.md'), 'ROUTED');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.ts'), '');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const run = (prompt, sessionId) => execFileSync('bash', [path.join(ROOT, 'hooks', 'review-routing-once.sh')], { input: JSON.stringify({ prompt, session_id: sessionId }), cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home } });
  const firingId = `harness-fire-${process.pid}-${Date.now()}`;
  const handBackId = `harness-handback-${process.pid}-${Date.now()}`;
  assert.match(run('review high', firingId), /ROUTED/);
  assert.equal(run('<agent-message from="a1">Reviewed it; review high effort=high</agent-message>', handBackId), '');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(`/tmp/claude-review-routing-${firingId}`, { force: true });
  fs.rmSync(`/tmp/claude-review-routing-${handBackId}`, { force: true });
});

test('review-routing: PR asks trigger and scope lenses to the PR diff', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'routing-pr-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'review-routing.md'), 'ROUTED');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // Only PR 123 has a diff; anything else fails like gh on a branch without a PR.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    '[ "$3" = "123" ] || exit 1',
    "cat <<'EOF'",
    'diff --git a/src/useAuth.ts b/src/useAuth.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/useAuth.ts',
    '@@ -0,0 +1,2 @@',
    '+export const token = read() ?? null;',
    '+export type Auth = { id: string };',
    'EOF',
  ].join('\n'), { mode: 0o755 });
  const run = (prompt) => execFileSync('bash', [path.join(ROOT, 'hooks', 'review-routing-once.sh')], {
    input: JSON.stringify({ prompt }), cwd: home, encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  for (const prompt of ['check PR', 'check the PR 999', 'checking a pull request', 'https://github.com/o/r/pull/9']) {
    assert.match(run(prompt), /ROUTED/, prompt);
  }
  for (const prompt of ['open a PR', 'commit and raise a PR', 'check prices']) {
    assert.equal(run(prompt), '', prompt);
  }
  assert.doesNotMatch(run('check PR 999'), /review-joins/);
  const joins = run('check PR 123');
  assert.match(joins, /verb=harden /);
  assert.match(joins, /high-risk=src\/useAuth\.ts /);
  assert.match(joins, /silent-failure-hunter/);
  assert.match(joins, /type-design-analyzer/);
  assert.match(joins, /added=2 new-files=1 pr=123>/);
  fs.rmSync(home, { recursive: true, force: true });
});
