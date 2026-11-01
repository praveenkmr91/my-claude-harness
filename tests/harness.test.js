'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const words = (text) => text.split(/\s+/).filter(Boolean).length;

const RULE_DOCS = [
  'CLAUDE.md',
  'persona-core.md',
  'hydrogen.md',
  'hydrogen-reference.md',
  'review-routing.md',
  'review-battery.md',
  'subagent-tiers.md',
  'external-io.md',
  'plan-mode.md',
  'plugin-curation.md',
  'harness.md',
  'code-craft.md',
  'committing.md',
  'peer-sessions.md',
];

const HOOK_SCRIPTS = fs.readdirSync(path.join(ROOT, 'hooks')).filter((f) => /\.(sh|js)$/.test(f));

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return data;
}

test.describe('pointers resolve', () => {
  for (const doc of RULE_DOCS) {
    test(`${doc}: every ~/.claude/ path and hooks/ script exists`, () => {
      const text = read(doc);
      const refs = new Set([
        ...(text.match(/~\/\.claude\/[A-Za-z0-9_./-]+/g) || []).map((p) => p.replace(/^~\/\.claude\//, '')),
        ...(text.match(/\bhooks\/[a-z0-9-]+\.(?:sh|js)(?![.\w])/g) || []),
      ]);
      const missing = [...refs].filter((rel) => !exists(rel.replace(/[.,;:)]+$/, '')));
      assert.deepEqual(missing, [], `${doc} points at missing paths`);
    });
  }

  test('settings.json: every hook command path exists', () => {
    const commands = JSON.stringify(JSON.parse(read('settings.json')).hooks);
    const paths = new Set(commands.match(/\/Users\/praveenkumar\/\.claude\/[A-Za-z0-9_./-]+/g) || []);
    const missing = [...paths].filter((p) => !fs.existsSync(p));
    assert.deepEqual(missing, []);
  });

  test('agent names cited in review docs exist in agents/, skills/ or a plugin', () => {
    const installed = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) installed.add(f.replace(/\.md$/, ''));
    for (const d of fs.readdirSync(path.join(ROOT, 'skills'))) installed.add(d);
    const out = execFileSync('find', [path.join(ROOT, 'plugins'), '-path', '*/agents/*.md'], { encoding: 'utf8' });
    for (const f of out.split('\n').filter(Boolean)) installed.add(path.basename(f, '.md'));

    const cited = new Set();
    for (const doc of ['review-routing.md', 'review-battery.md', 'subagent-tiers.md']) {
      for (const name of read(doc).match(/\b[a-z]+(?:-[a-z]+)*-(?:analyzer|reviewer|hunter|simplifier|explorer)\b/g) || []) {
        cited.add(name.replace(/^[a-z-]+:/, ''));
      }
    }
    const missing = [...cited].filter((n) => !installed.has(n));
    assert.deepEqual(missing, []);
  });
});

test.describe('frontmatter', () => {
  const skillDirs = fs.readdirSync(path.join(ROOT, 'skills')).filter((d) => exists(`skills/${d}/SKILL.md`));
  for (const dir of skillDirs) {
    test(`skills/${dir}: name matches directory, description present`, () => {
      const fm = frontmatter(read(`skills/${dir}/SKILL.md`));
      assert.ok(fm, 'no frontmatter');
      assert.equal(fm.name, dir);
      assert.ok(fm.description, 'missing description');
    });
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))) {
    test(`agents/${file}: name matches filename, description carries a trigger`, () => {
      const fm = frontmatter(read(`agents/${file}`));
      assert.ok(fm, 'no frontmatter');
      assert.equal(fm.name, path.basename(file, '.md'));
      assert.match(fm.description ?? '', /Use (when|for)/);
    });
    test(`agents/${file}: body matches its tool grants`, () => {
      const text = read(`agents/${file}`);
      const fm = frontmatter(text);
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
      if (fm?.tools !== undefined) {
        const granted = fm.tools.split(/,\s*/);
        assert.ok(!granted.includes('AskUserQuestion'), 'AskUserQuestion granted to a subagent');
        if (body.includes('Skill(')) assert.ok(granted.some((t) => /^Skill\b/.test(t)), 'body names Skill( without the grant');
        if (/\bBash\b/.test(body)) assert.ok(granted.includes('Bash'), 'body names Bash without the grant');
      }
      const askSentences = body
        .split(/(?<=[.!?])\s+|\n+/)
        .filter((s) => /ask the user|confirm with the user/i.test(s) && !/cannot|never|no way|not available/i.test(s));
      assert.deepEqual(askSentences, [], 'a subagent cannot ask the user');
    });
  }
});

test.describe('hook scripts', () => {
  for (const script of HOOK_SCRIPTS) {
    test(`hooks/${script} parses`, () => {
      const abs = path.join(ROOT, 'hooks', script);
      if (script.endsWith('.sh')) execFileSync('bash', ['-n', abs]);
      else execFileSync('node', ['--check', abs]);
    });
  }

  const libDir = path.join(ROOT, 'hooks', 'lib');
  for (const module of fs.readdirSync(libDir).filter((f) => f.endsWith('.jq'))) {
    test(`hooks/lib/${module} parses`, () => {
      execFileSync('jq', ['-n', '-L', libDir, `include "${path.basename(module, '.jq')}"; true`]);
    });
  }

  test('hooks invoked by bare path are executable', () => {
    const commands = JSON.parse(read('settings.json')).hooks;
    const bare = JSON.stringify(commands).match(/"command":"\/Users\/praveenkumar\/\.claude\/hooks\/[^"\s]+/g) || [];
    for (const entry of bare) {
      const abs = entry.replace(/^"command":"/, '');
      assert.doesNotThrow(() => fs.accessSync(abs, fs.constants.X_OK), `${abs} not executable`);
    }
  });

  test('shellcheck over hooks/*.sh', { skip: !hasBinary('shellcheck') && 'shellcheck not installed' }, () => {
    for (const script of HOOK_SCRIPTS.filter((f) => f.endsWith('.sh'))) {
      execFileSync('shellcheck', ['-S', 'warning', path.join(ROOT, 'hooks', script)]);
    }
  });
});

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('agent-file-scope: flags writes outside the brief, tolerates a sentence-ending path', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scope-'));
  fs.mkdirSync(path.join(home, '.claude', 'hooks-logs'), { recursive: true });
  const listed = path.join(home, 'listed.txt');
  const unlisted = path.join(home, 'unlisted.txt');
  fs.writeFileSync(listed, '');
  fs.writeFileSync(unlisted, '');
  const transcript = path.join(home, 'agent.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: `Edit ${listed}.` } }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: listed } },
      { type: 'tool_use', name: 'Write', input: { file_path: unlisted } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/private/tmp/claude-501/x/scratchpad/notes.md' } },
    ] } }),
  ].join('\n'));
  const payload = JSON.stringify({ stop_hook_active: false, agent_type: 'test', cwd: home, agent_transcript_path: transcript });
  const out = execFileSync('bash', [path.join(ROOT, 'hooks', 'agent-file-scope.sh')], { input: payload, encoding: 'utf8', env: { ...process.env, HOME: home } });
  const message = JSON.parse(out).systemMessage;
  assert.match(message, new RegExp(unlisted));
  assert.doesNotMatch(message, new RegExp(listed));
  assert.doesNotMatch(message, /scratchpad/);
  fs.rmSync(home, { recursive: true, force: true });
});

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

test('correction-learn: fires on repeated corrections, silent on ordinary prompts', () => {
  const hook = path.join(ROOT, 'hooks', 'correction-learn.sh');
  const fires = (prompt) => execFileSync('bash', [hook], { input: JSON.stringify({ prompt }), encoding: 'utf8' }).includes('<correction-learn>');
  // Prompts copied from session transcripts (2026-09-13..25 census).
  for (const p of [
    'i told u many times. make the components flexible regarless of callers yet.',
    'why do u keep missing ? all figma calls must go through tooling/',
    'i didnt approve plan. i only told u to review. whats wrong with u',
    'waht the heck. i said its ok not to be parllel. use sonnet stupid',
    'how many times do i have to tell u not to be too verbose',
  ]) assert.ok(fires(p), p);
  for (const p of [
    'approved again',
    'why do u need seperate branch?',
    'as i said, now we have liberty/ freedom/ power to decide on architecture.',
    'meeting ended. lets find answers on our own instead of rushing to asking stupid questions',
    '<task-notification>i told you</task-notification>',
    '<agent-message from="a1">\n[Subagent hand-back] The report follows:\n  "i didnt approve plans. why are u implementing already?"\n</agent-message>',
  ]) assert.ok(!fires(p), p);
});

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

test.describe('rule and hook agree', () => {
  const pairs = [
    ['hooks/block-dangerous-git.sh', /co-authored-by/i, 'committing.md', /Co-Authored-By/],
    ['hooks/commit-trailer-check.sh', /co-authored-by/i, 'committing.md', /commit-trailer-check\.sh/],
    ['hooks/block-dangerous-git.sh', /push and PR need a yes/, 'committing.md', /`gh pr create` hook-asked/],
    ['hooks/done-claim-gate.sh', /ran git commit/, 'committing.md', /Stop gate checks lint and lenses on any committing turn/],
    ['hooks/enforce-subagent-model.sh', /is review\/planning work/, 'subagent-tiers.md', /denied for review\/planning agents \(one exception/],
    ['hooks/enforce-subagent-model.sh', /= "Explore" \] && inject "haiku"/, 'subagent-tiers.md', /\| Explore \| Haiku always/],
    ['hooks/enforce-subagent-model.sh', /is_brain_agent" = true \][\s\S]*inject "opus"/, 'subagent-tiers.md', /sub-Opus session the hook injects opus/],
    ['settings.json', /inject-once\.sh subagent-tiers\.md/, 'CLAUDE.md', /injected on the first Agent call/],
    ['settings.json', /inject-once\.sh browser-verify\.md/, 'CLAUDE.md', /injected on the first chrome-devtools call/],
    ['settings.json', /inject-once\.sh external-io\.md/, 'CLAUDE.md', /external-io\.md`, injected on the first MCP, `gh` or `curl` call/],
    ['settings.json', /"if": "Bash\(gh:\*\)",[^}]*inject-once\.sh external-io\.md[^"]*"|inject-once\.sh external-io\.md[^"]*",[^}]*"if": "Bash\(gh:\*\)"/, 'CLAUDE.md', /injected on the first MCP, `gh` or `curl` call/],
    ['settings.json', /"if": "Bash\(curl:\*\)",[^}]*inject-once\.sh external-io\.md[^"]*"|inject-once\.sh external-io\.md[^"]*",[^}]*"if": "Bash\(curl:\*\)"/, 'CLAUDE.md', /injected on the first MCP, `gh` or `curl` call/],
    ['settings.json', /inject-once\.sh peer-sessions\.md/, 'CLAUDE.md', /injected on the first SendMessage/],
    ['settings.json', /inject-once\.sh code-craft\.md '\[\.\]\(tsx\?[^']*\|sh\|[^']*dart\)[$]'/, 'CLAUDE.md', /code-craft\.md`\*\*.*injected on the first Read, Write or Edit of a source file/],
    ['settings.json', /"if": "Bash\(git:\*\)",[^}]*inject-once\.sh committing\.md[^"]*"|inject-once\.sh committing\.md[^"]*",[^}]*"if": "Bash\(git:\*\)"/, 'CLAUDE.md', /committing\.md`\*\*, injected on the first git command/],
    ['hooks/new-dep-gate.js', /dependency ladder/, 'CLAUDE.md', /installs and new `package\.json` keys are hook-asked/],
    ['hooks/enforce-subagent-model.sh', /Fable needs a confirmed Opus session/, 'subagent-tiers.md', /fails CLOSED/],
    ['hooks/comment-delta-check.js', /ZERO by default/, 'code-craft.md', /default to ZERO/],
    ['settings.json', /tsx\?\|jsx\?\|mjs\|cjs\|mts\|cts\|sh\|vue\|svelte\|css\|scss\|swift\|kts\?\|dart/, 'hooks/comment-delta-check.js', /tsx\?\|jsx\?\|mjs\|cjs\|mts\|cts\|sh\|vue\|svelte\|css\|scss\|swift\|kts\?\|dart/],
    ['hooks/comment-delta-check.js', /when to upgrade/, 'code-craft.md', /when to upgrade/],
    ['hooks/comment-delta-check.js', /until\|once\|when\|upgrade\|revisit\|lands\?\|replaced\?\|before/, 'commands/shortcut-debt.md', /until\|once\|when\|upgrade\|revisit\|lands\?\|replaced\?\|before/],
    ['hooks/agent-file-scope.sh', /wrote outside the files its brief named/, 'code-craft.md', /Surgical on build tasks/],
    ['hooks/done-claim-gate.sh', /REVIEW NOT RUN/, 'review-routing.md', /Stop gate blocks/],
    ['hooks/done-claim-gate.sh', /'Pass'/, 'review-routing.md', /`Pass: <verb>`/],
    ['hooks/done-claim-gate.sh', /LINT\/TSC NOT RUN/, 'CLAUDE.md', /run linter \+ type checker/],
    ['hooks/block-dangerous-git.sh', /updatedInput/, 'CLAUDE.md', /auto-quotes unquoted/],
    ['hooks/audit-due.sh', /--stamp/, 'review-routing.md', /audit-due\.sh --stamp/],
    ['hooks/review-lens-nudge.sh', /Review lenses for this change/, 'review-routing.md', /nudge the lens list mid-turn/],
    ['hooks/review-classify.sh', /effort=\$EFFORT/, 'review-routing.md', /`effort=` on the joins line/],
    ['hooks/bash-write-guard.js', /Use Write or Edit/, 'harness.md', /bash-write-guard\.js` blocks them/],
    ['hooks/docs-context.sh', /library-docs\.md/, 'CLAUDE.md', /cites `pkg@x\.y\.z`/],
    ['hooks/plan-lint.js', /rephrase as an instruction/, 'plan-mode.md', /plan-lint\.js` refuses/],
    ['hooks/plan-lint.js', /has no step/, 'plan-mode.md', /\(P7\)/],
    ['hooks/bash-write-guard.js', /edit plan files with Write or Edit/, 'harness.md', /which only Write or Edit may change/],
    ['hooks/browser-main-guard.sh', /browser-verifier/, 'external-io.md', /browser-main-guard\.sh/],
    ['hooks/done-claim-gate.sh', /pass\|fail\|blocked/, 'agents/browser-verifier.md', /pass\|fail\|blocked/],
    ['hooks/enforce-subagent-model.sh', /no `subagent_type`/, 'subagent-tiers.md', /no `subagent_type`/],
    ['hooks/enforce-subagent-model.sh', /cold-reader/, 'plan-mode.md', /cold-reader/],
    ['hooks/inline-call-nudge.sh', /direct lookups/, 'subagent-tiers.md', /inline-call-nudge\.sh/],
    ['hooks/inline-call-nudge.sh', /≤3 direct calls per question/, 'CLAUDE.md', /≤3 calls per question, all rounds counted; a 4th → Explore/],
    ['hooks/opus-write-nudge.sh', /about to write source/, 'subagent-tiers.md', /first source write of every turn/],
    ['hooks/step-gate.sh', /handed back with no/, 'plan-mode.md', /step-gate\.sh/],
    ['hooks/step-gate.sh', /handed back with no/, 'README.md', /step-gate\.sh/],
    ['hooks/done-claim-gate.sh', /REPORT WITHOUT RAW OUTPUT/, 'peer-sessions.md', /done-claim-gate\.sh refuses the send/],
    ['hooks/done-claim-gate.sh', /the lens lines go in the message itself/, 'README.md', /refuses a REPORT send/],
    ['hooks/done-claim-gate.sh', /a hand pass does not count/, 'review-routing.md', /hand-written findings line does not count/],
    ['hooks/step-gate.sh', /No dry-runner dispatch/, 'peer-sessions.md', /step-gate\.sh enforces/],
    ['hooks/step-gate.sh', /No dry-runner dispatch/, 'plan-mode.md', /first implementer dispatch until a dry-runner/],
    ['hooks/step-gate.sh', /No dry-runner dispatch/, 'README.md', /first dispatch until its dry run/],
  ];
  for (const [hook, hookPattern, doc, docPattern] of pairs) {
    test(`${hook} ↔ ${doc}: ${docPattern.source}`, () => {
      assert.match(read(hook), hookPattern, `${hook} no longer enforces this`);
      assert.match(read(doc), docPattern, `${doc} no longer states the rule the hook enforces`);
    });
  }

  test('settings.json: the SendMessage PreToolUse group runs done-claim-gate.sh', () => {
    const group = JSON.parse(read('settings.json')).hooks.PreToolUse.find((g) => g.matcher === 'SendMessage');
    assert.ok(group, 'no PreToolUse group matches SendMessage');
    assert.ok(group.hooks.some((h) => h.command.endsWith('hooks/done-claim-gate.sh')), 'a REPORT send is never gated: done-claim-gate.sh is not wired on SendMessage');
  });
});

test('eval-run.sh: the cold-read brief grep yields the brief without the dispatch-prompt rule', () => {
  const brief = execFileSync('grep', ['-o', 'You will execute this plan with only this file.*Do not redesign\\.', path.join(ROOT, 'agents/cold-reader.md')], { encoding: 'utf8' });
  assert.ok(brief.startsWith('You will execute'), 'the brief must start at "You will execute"');
  assert.doesNotMatch(brief, /dispatch prompt/, 'the brief must not carry the dispatch-prompt rule');
});

test('reset-context-flags.sh: every hook flag is reset on compaction or is a nudge counter', () => {
  const reset = read('hooks/reset-context-flags.sh');
  const counters = ['claude-review-lenses', 'claude-inline-calls'];
  const prefixes = new Set();
  for (const script of HOOK_SCRIPTS) {
    for (const m of read(`hooks/${script}`).matchAll(/\/tmp\/(claude-[a-z-]+?)-\$/g)) prefixes.add(m[1]);
  }
  const unreset = [...prefixes].filter((p) => !reset.includes(`/tmp/${p}-`) && !counters.some((c) => p.startsWith(c)));
  assert.deepEqual(unreset, [], 'a new context-injection flag must be cleared in reset-context-flags.sh');
});

test('context-canary: every expected answer appears in its source file', () => {
  const script = read('automation/context-canary.sh');
  const defs = [/^C=.*$/m, /^MEMORY_CWD=.*$/m, /^SOURCES=\([\s\S]*?\)$/m, /^EXPECT=\([\s\S]*?\)$/m]
    .map((pattern) => script.match(pattern)[0])
    .join('\n');
  const pairs = execFileSync('bash', ['-c', `${defs}; for i in "\${!SOURCES[@]}"; do printf '%s\\t%s\\n' "\${SOURCES[$i]}" "\${EXPECT[$i]}"; done`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const failures = [];
  for (const [source, expected] of pairs) {
    if (!fs.existsSync(source)) failures.push(`${source} does not exist`);
    else if (!fs.readFileSync(source, 'utf8').includes(expected)) failures.push(`${source} lacks "${expected}"`);
  }
  assert.ok(pairs.length > 0, 'no SOURCES/EXPECT pairs resolved from context-canary.sh');
  assert.deepEqual(failures, [], 'update the canary question in automation/context-canary.sh when moving the text');
});

test('block-dangerous-git.sh: every command family it guards has its own if-gate', () => {
  const families = [
    ['git', /git (push|commit|add)/],
    ['gh', /GH_PR='\\bgh\(/],
    ['cp', /\\bcp\\b[^\n]*node_modules/],
    ['rm', /\\brm\\b[^\n]*package-lock/],
  ];
  const script = read('hooks/block-dangerous-git.sh');
  const gates = JSON.parse(read('settings.json')).hooks.PreToolUse
    .flatMap((entry) => entry.hooks)
    .filter((hook) => hook.command.endsWith('hooks/block-dangerous-git.sh'))
    .map((hook) => hook.if);
  for (const [family, guard] of families) {
    assert.match(script, guard, `script no longer guards ${family}; drop it from this list`);
    assert.ok(gates.includes(`Bash(${family}:*)`), `no Bash(${family}:*) if-gate: the ${family} guard never runs`);
  }
});

test('plugin-curation.md: every enabledPlugins key has exactly one row in the table matching its value', () => {
  const enabled = JSON.parse(read('settings.json')).enabledPlugins;
  const doc = read('plugin-curation.md');
  const table = (heading) => {
    const section = doc.split(/\n(?=## )/).find((s) => s.startsWith(heading));
    return [...section.matchAll(/^\| `([^`]+@[^`]+)` \|/gm)].map((m) => m[1]);
  };
  const rows = [
    ...table('## Always-on core').map((key) => [key, true]),
    ...table('## Tombstones').map((key) => [key, false]),
  ];
  const documented = rows.map(([key]) => key);
  const problems = [
    ...documented.filter((key, i) => documented.indexOf(key) !== i).map((key) => `${key}: more than one row`),
    ...rows.filter(([key, value]) => enabled[key] !== value).map(([key, value]) => `${key}: doc says ${value}, settings says ${enabled[key]}`),
    ...Object.keys(enabled).filter((key) => !documented.includes(key)).map((key) => `${key}: no row`),
  ];
  assert.deepEqual(problems, []);
});

test.describe('always-load budget', () => {
  const baseline = JSON.parse(read('tests/budget-baseline.json'));
  for (const [doc, ceiling] of Object.entries(baseline)) {
    test(`${doc} ≤ ${ceiling} words`, () => {
      const count = words(read(doc));
      assert.ok(count <= ceiling, `${doc} is ${count} words, ceiling ${ceiling}; trim or raise the baseline deliberately`);
    });
  }
});

test('one tier owns a rule: no sentence repeated across rule docs', () => {
  const docs = RULE_DOCS.filter((d) => d !== 'persona-core.md');
  const seen = new Map();
  const dupes = [];
  for (const doc of docs) {
    for (const raw of read(doc).split(/(?<=[.!?])\s+|\n/)) {
      const sentence = raw.replace(/[*`_>-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (words(sentence) < 10) continue;
      const owner = seen.get(sentence);
      if (owner && owner !== doc) dupes.push(`${owner} + ${doc}: "${sentence.slice(0, 80)}"`);
      else seen.set(sentence, doc);
    }
  }
  assert.deepEqual(dupes, []);
});
