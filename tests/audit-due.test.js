'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('audit-due: first startup starts the clock silently, nudges after 30 days, silent once stamped', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audit-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const hook = path.join(ROOT, 'hooks', 'audit-due.sh');
  const env = { ...process.env, HOME: home };
  const start = (source) => execFileSync('bash', [hook], { input: JSON.stringify({ source, cwd: repo }), encoding: 'utf8', env });
  assert.equal(start('startup'), '');
  const stamp = path.join(home, '.claude', 'state', 'audit', fs.realpathSync(repo).replaceAll('/', '_'));
  const monthAgo = new Date(Date.now() - 31 * 86400 * 1000);
  fs.utimesSync(stamp, monthAgo, monthAgo);
  const nudge = JSON.parse(start('startup'));
  assert.match(nudge.systemMessage, /Audit due for repo \(no audit in 31 days\)/);
  assert.equal(nudge.hookSpecificOutput, undefined);
  assert.equal(start('clear'), '');
  const skill = (name) => execFileSync('bash', [hook, '--on-skill'], { input: JSON.stringify({ tool_input: { skill: name }, cwd: repo }), encoding: 'utf8', env });
  skill('react-best-practices');
  assert.match(start('startup'), /Audit due/);
  skill('delete-audit');
  assert.equal(start('startup'), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('audit-due: lands the newest weekly report once, on startup or resume', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audit-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const hook = path.join(ROOT, 'hooks', 'audit-due.sh');
  const env = { ...process.env, HOME: home };
  const start = (source) => execFileSync('bash', [hook], { input: JSON.stringify({ source, cwd: repo }), encoding: 'utf8', env });
  const reports = path.join(home, '.claude', 'state', 'audits', 'repo');
  fs.mkdirSync(reports, { recursive: true });
  const landed = path.join(repo, 'docs', 'audits', 'audit.md');
  fs.writeFileSync(path.join(reports, '2026-10-05.md'), 'old');
  fs.utimesSync(path.join(reports, '2026-10-05.md'), new Date(Date.now() - 86400 * 1000), new Date(Date.now() - 86400 * 1000));
  fs.writeFileSync(path.join(reports, '2026-10-12.md'), 'new');
  assert.equal(start('clear'), '');
  assert.equal(fs.existsSync(landed), false);
  assert.match(JSON.parse(start('resume')).systemMessage, /Weekly audit 2026-10-12 landed/);
  assert.equal(fs.readFileSync(landed, 'utf8'), 'new');
  assert.doesNotMatch(start('startup'), /landed/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('audit-due: a symlink on the landing path skips the landing', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'audit-'));
  const hook = path.join(ROOT, 'hooks', 'audit-due.sh');
  const env = { ...process.env, HOME: home };
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  const victim = path.join(outside, 'victim.md');
  const repoWith = (name, link) => {
    const repo = path.join(home, name);
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const reports = path.join(home, '.claude', 'state', 'audits', name);
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, '2026-10-12.md'), 'report');
    link(repo);
    return execFileSync('bash', [hook], { input: JSON.stringify({ source: 'resume', cwd: repo }), encoding: 'utf8', env });
  };
  fs.writeFileSync(victim, 'mine');
  const old = new Date(Date.now() - 86400 * 1000);
  fs.utimesSync(victim, old, old);
  const viaFile = repoWith('file-link', (repo) => {
    fs.mkdirSync(path.join(repo, 'docs', 'audits'), { recursive: true });
    fs.symlinkSync(victim, path.join(repo, 'docs', 'audits', 'audit.md'));
  });
  assert.doesNotMatch(viaFile, /landed/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'mine');
  for (const [name, at] of [['dir-link', ['docs', 'audits']], ['docs-link', ['docs']]]) {
    const out = repoWith(name, (repo) => {
      fs.mkdirSync(path.join(repo, ...at.slice(0, -1)), { recursive: true });
      fs.symlinkSync(outside, path.join(repo, ...at));
    });
    assert.doesNotMatch(out, /landed/, name);
  }
  assert.deepEqual(fs.readdirSync(outside), ['victim.md']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('audit-due: empty input exits 0 with no output', () => {
  const out = execFileSync('bash', [path.join(ROOT, 'hooks', 'audit-due.sh')], { input: '{}', encoding: 'utf8' });
  assert.equal(out, '');
});
