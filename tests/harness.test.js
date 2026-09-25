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
  'plan-mode.md',
  'plugin-curation.md',
  'harness.md',
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
    test(`agents/${file}: name matches filename, description present`, () => {
      const fm = frontmatter(read(`agents/${file}`));
      assert.ok(fm, 'no frontmatter');
      assert.equal(fm.name, path.basename(file, '.md'));
      assert.ok(fm.description, 'missing description');
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
  for (const file of ['src/useAuth.ts', 'src/use-session.ts', 'src/recorder.ts', 'author-rules/x.md', 'styles/tokens.css']) {
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
  assert.doesNotMatch(risk, /recorder|author-rules|tokens\.css/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(`/tmp/claude-review-routing-${sessionId}`, { force: true });
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

test.describe('rule and hook agree', () => {
  const pairs = [
    ['hooks/block-dangerous-git.sh', /co-authored-by/i, 'CLAUDE.md', /Co-Authored-By/],
    ['hooks/enforce-subagent-model.sh', /is review\/planning work/, 'CLAUDE.md', /on a review\/planning agent is denied/],
    ['hooks/enforce-subagent-model.sh', /= "Explore" \] && inject "haiku"/, 'CLAUDE.md', /Explore → Haiku always/],
    ['hooks/enforce-subagent-model.sh', /is_brain_agent" = true \][\s\S]*inject "opus"/, 'CLAUDE.md', /sub-Opus session the hook injects Opus/],
    ['hooks/enforce-subagent-model.sh', /Fable needs a confirmed Opus session/, 'subagent-tiers.md', /fails CLOSED/],
    ['hooks/comment-delta-check.js', /ZERO by default/, 'CLAUDE.md', /default to ZERO/],
    ['hooks/agent-file-scope.sh', /wrote outside the files its brief named/, 'CLAUDE.md', /Surgical on build tasks/],
    ['hooks/done-claim-gate.sh', /REVIEW NOT RUN/, 'review-routing.md', /Stop gate blocks/],
    ['hooks/audit-due.sh', /--stamp/, 'review-routing.md', /audit-due\.sh --stamp/],
    ['hooks/review-lens-nudge.sh', /Review lenses for this change/, 'review-routing.md', /nudge the lens list mid-turn/],
    ['hooks/bash-write-guard.js', /Use Write or Edit/, 'harness.md', /bash-write-guard\.js` blocks them/],
    ['hooks/docs-context.sh', /library-docs\.md/, 'CLAUDE.md', /cites `pkg@x\.y\.z`/],
  ];
  for (const [hook, hookPattern, doc, docPattern] of pairs) {
    test(`${hook} ↔ ${doc}: ${docPattern.source}`, () => {
      assert.match(read(hook), hookPattern, `${hook} no longer enforces this`);
      assert.match(read(doc), docPattern, `${doc} no longer states the rule the hook enforces`);
    });
  }
});

test('block-dangerous-git.sh: every command family it guards has its own if-gate', () => {
  const families = [
    ['git', /git (push|commit|add)/],
    ['gh pr', /gh pr \(create\|edit\)/],
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
