'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'review-classify.py');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-classify-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function lensesFor(source, { packageJson, file = 'src.ts' } = {}) {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, file), source);
  if (packageJson) fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(packageJson));
  const out = execFileSync('python3', [HOOK_PATH], { input: '{}', cwd: repo, encoding: 'utf8' });
  return out.match(/lenses=(\S+)/)[1].split(',');
}

// Under the pre-commit hook git exports GIT_INDEX_FILE etc.; inherited, they point the scratch repo at ~/.claude's index.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function joinsForEdit({ files, payload = () => ({}), stdin, locale }) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env });
  git('init', '-q');
  for (const [name, [committed]] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), committed);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  for (const [name, [, modified]] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), modified);
  const input = stdin ?? JSON.stringify(payload(repo));
  return execFileSync('python3', [HOOK_PATH], { input, cwd: repo, encoding: 'utf8', env: locale ? { ...env, LC_ALL: locale } : env });
}

const cases = [
  ['silent-failure-hunter', 'try { f() } catch (e) {}', 'if (a || b) run(); const v = a?.b;'],
  ['silent-failure-hunter', 'const v = a ?? 1; const w = b || [];', 'const v = a?.b;'],
  ['type-design-analyzer', 'export type Foo = { a: string };\ninterface Bar {}', 'const type = 1;'],
  ['comment-analyzer', '// one\n// two\n/** three */\nconst a = 1;', '// one\n// two\nconst a = 1;'],
  ['modern-ts-analyzer', 'var x = 1; if (a.indexOf(b) !== -1) {}', 'const isVar = 1; const avar = 2;'],
  ['impeccable', 'const c = <div className="p-4 flex">{x}</div>;', 'const c = <div>{x}</div>;'],
];

test('review-classify content signals', async (t) => {
  for (const [lens, hit, miss] of cases) {
    await t.test(`${lens}: joins on ${JSON.stringify(hit)}, not on ${JSON.stringify(miss)}`, () => {
      assert.ok(lensesFor(hit).includes(lens));
      assert.ok(!lensesFor(miss).includes(lens));
    });
  }

  await t.test('ignores signal text inside test files', () => {
    assert.ok(!lensesFor('p.catch(() => null);', { file: 'api.test.ts' }).includes('silent-failure-hunter'));
  });

  await t.test('impeccable joins on a stylesheet change', () => {
    assert.ok(lensesFor('.a { color: red; }', { file: 'a.css' }).includes('impeccable'));
  });

  await t.test('auto-bundles carry only their own members', () => {
    const risk = lensesFor('export const a = 1;', { file: 'session.ts' });
    assert.ok(risk.includes('adversarial-reviewer') && risk.includes('security-review'));
    assert.ok(!risk.includes('silent-failure-hunter') && !risk.includes('type-design-analyzer'));
    const bulk = lensesFor(Array.from({ length: 200 }, (_, i) => `export const a${i} = ${i};\n`).join(''));
    assert.ok(bulk.includes('delete-list'));
    for (const lens of ['shortcut-debt', 'comment-analyzer', 'modern-ts-analyzer']) assert.ok(!bulk.includes(lens));
  });

  await t.test('pr-test-analyzer: joins only when the repo has a real test script', () => {
    const source = 'export const a = 1;';
    assert.ok(lensesFor(source, { packageJson: { scripts: { test: 'vitest' } } }).includes('pr-test-analyzer'));
    assert.ok(!lensesFor(source, { packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } }).includes('pr-test-analyzer'));
    assert.ok(!lensesFor(source).includes('pr-test-analyzer'));
  });
});

function joinsFor(prompt, { source } = {}) {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (source !== undefined) fs.writeFileSync(path.join(repo, 'src.ts'), source);
  return execFileSync('python3', [HOOK_PATH], { input: JSON.stringify({ prompt }), cwd: repo, encoding: 'utf8' });
}

test('review-classify scopes the edited file', async (t) => {
  const files = {
    'a.ts': ['export const a = 1;\n', 'export const a = 1;\nexport const a2 = 2;\nexport const a3 = 3;\n'],
    'b.ts': ['export const b = 1;\n', 'export const b = 1;\nexport const b2 = 2;\nexport const b3 = 3;\nexport const b4 = 4;\n'],
  };

  await t.test('payload file_path scopes the first edit to that file', () => {
    const out = joinsForEdit({ files, payload: (repo) => ({ tool_input: { file_path: path.join(repo, 'b.ts') } }) });
    assert.match(out, / added=3 /);
  });

  await t.test('payload without file_path leaves the dirty tree in scope', () => {
    assert.match(joinsForEdit({ files }), / added=5 /);
  });

  await t.test('empty stdin exits 0', () => {
    assert.doesNotThrow(() => joinsForEdit({ files, stdin: '' }));
  });
});

test('review-classify comment-only exit', async (t) => {
  const commentOnly = / verb=review lenses=comment-analyzer /;
  const base = 'export const a = 1;\n';
  const joinsAdding = (added, { name = 'session.ts', committed = base } = {}) => joinsForEdit({ files: { [name]: [committed, committed + added] } });

  await t.test('a comment added to a committed risk-named file routes comment-analyzer alone', () => {
    assert.match(joinsAdding('// why\n'), commentOnly);
  });

  await t.test('a wrapped JSX comment added in a .tsx routes comment-analyzer alone', () => {
    assert.match(joinsAdding('{/* a\n b */}\n', { name: 'view.tsx' }), commentOnly);
  });

  const quiet = [
    ['plus one code line', '// why\nexport const b = 2;\n'],
    ['code before a closing comment', '/* a */ foo()\n'],
    ['a lint directive', '// oxlint-disable-next-line\n'],
    ['a multiplication continuation', '  * rate\n'],
    ['a regex literal ending in */', 'const RE = /a*/\n'],
  ];
  for (const [name, added] of quiet) {
    await t.test(`quiet: ${name}`, () => {
      assert.doesNotMatch(joinsAdding(added), / lenses=comment-analyzer /);
    });
  }

  await t.test('quiet: a removed code line', () => {
    const out = joinsForEdit({ files: { 'session.ts': [`${base}export const b = 2;\n`, base] } });
    assert.doesNotMatch(out, / lenses=comment-analyzer /);
  });

  await t.test('quiet: an untracked comment-only file', () => {
    const payload = (repo) => { fs.writeFileSync(path.join(repo, 'notes.ts'), '// why\n'); return {}; };
    const out = joinsForEdit({ files: { 'session.ts': [base, `${base}// why\n`] }, payload });
    assert.doesNotMatch(out, / lenses=comment-analyzer /);
  });
});

test('review-classify review_base', async (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' }).trim();
  const commit = (file, source = 'export const a = 1;\n') => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), source);
    git('add', '.');
    git('commit', '-q', '-m', file);
    return git('rev-parse', '--short', 'HEAD');
  };
  git('init', '-q');
  const root = commit('README.md');
  commit('src/c.ts', 'p.catch(() => null);\n');
  const step1 = commit('src/a.tsx');
  commit('docs/b.md');
  commit('src/d.ts');
  const transcript = path.join(tmpDir, 'since.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: '2020-01-01T00:00:00.000Z' })}\n`);
  const lensesFrom = (review_base, transcript_path = transcript) => execFileSync('python3', [HOOK_PATH], { input: JSON.stringify({ transcript_path, review_base }), cwd: repo, encoding: 'utf8', env }).match(/lenses=(\S+)/)[1].split(',');

  await t.test('lenses come from the delta after the base only', () => {
    assert.ok(!lensesFrom(step1).includes('react-best-practices'));
    assert.ok(lensesFrom(root).includes('react-best-practices'));
  });

  await t.test('content signals come from the delta after the base only', () => {
    assert.ok(!lensesFrom(step1).includes('silent-failure-hunter'));
    assert.ok(lensesFrom(undefined).includes('silent-failure-hunter'));
  });

  await t.test('an unresolvable base falls back to the session scope', () => {
    assert.ok(lensesFrom('deadbee').includes('react-best-practices'));
  });

  const editTranscript = path.join(tmpDir, 'edit.jsonl');
  const editEntry = { type: 'assistant', timestamp: '2020-01-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, 'docs/x.md') } }] } };
  fs.writeFileSync(editTranscript, `${JSON.stringify(editEntry)}\n`);

  await t.test('the base outranks a session edit', () => {
    assert.ok(lensesFrom(root, editTranscript).includes('react-best-practices'));
  });

  await t.test('without a base the session edit scopes the review', () => {
    assert.ok(!lensesFrom(undefined, editTranscript).includes('react-best-practices'));
  });
});

test('review-classify effort level', async (t) => {
  const source = 'export const a = 1;';
  const stated = [
    ['review high', 'high'], ['effort=low', 'low'], ['battery at max effort', 'high'],
    ['Review xhigh.', 'high'], ['code review medium please', 'medium'], ['effort: Low', 'low'],
    ['review high: the auth flow', 'high'], ['high-effort review please', 'high'],
  ];
  for (const [prompt, level] of stated) {
    await t.test(`${JSON.stringify(prompt)} → effort=${level}`, () => {
      assert.match(joinsFor(prompt, { source }), new RegExp(` effort=${level}>$`, 'm'));
    });
  }

  for (const prompt of ['review the high-risk path', 'review the high efforts page', 'review high-risk code', 'code-review --max-findings all', 'review, low priority', 'review max-width styles', 'review']) {
    await t.test(`${JSON.stringify(prompt)} → no effort`, () => {
      const out = joinsFor(prompt, { source });
      assert.match(out, /verb=review /);
      assert.doesNotMatch(out, /effort=/);
    });
  }

  await t.test('empty scope keeps a stated level and stays silent without one', () => {
    assert.equal(joinsFor('review high'), '<review-joins effort=high>\n');
    assert.equal(joinsFor('review'), '');
  });

  await t.test('non-git dir keeps a stated level', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'plain-'));
    const run = (prompt) => execFileSync('python3', [HOOK_PATH], { input: JSON.stringify({ prompt }), cwd: dir, encoding: 'utf8' });
    assert.equal(run('review high'), '<review-joins effort=high>\n');
    assert.equal(run('review'), '');
  });
});

const stamp = (seconds = 0) => new Date(Date.UTC(2099, 0, 1, 0, 0, seconds)).toISOString();
const sourceLines = (count, first = 'export const v0 = 0;') => [first, ...Array.from({ length: count - 1 }, (_, i) => `export const v${i + 1} = ${i + 1};`)].join('\n') + '\n';
const withCatch = 'try { run(); } catch (e) { report(e); }';
const toolCall = (name, input, { id, at, type = 'assistant' } = {}) => ({ type, ...(at && { timestamp: at }), message: { content: [{ type: 'tool_use', id, name, input }] } });
const writeOf = (file, content, opts) => toolCall('Write', { file_path: file, content }, opts);
const editOf = (file, newString, opts) => toolCall('Edit', { file_path: file, old_string: 'x', new_string: newString }, opts);
const dispatchOf = (subagentType, opts) => toolCall('Agent', { subagent_type: subagentType, description: 'review', prompt: 'review' }, opts);
const resultOf = (id, { error = false, at } = {}) => ({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, ...(error && { is_error: true }), content: 'out' }] } });

function classifyTranscript({ main, agents, unreadable = [], onDisk = {}, commit = {}, input = {}, stdin }) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env });
  const write = (files) => { for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), source); };
  git('init', '-q');
  if (Object.keys(commit).length) { write(commit); git('add', '.'); git('commit', '-q', '-m', 'init'); }
  write(onDisk);
  const transcript = path.join(fs.mkdtempSync(path.join(tmpDir, 'transcript-')), 'main.jsonl');
  const jsonl = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join('');
  fs.writeFileSync(transcript, jsonl(main?.(repo) ?? []));
  if (agents || unreadable.length) {
    const dir = path.join(path.dirname(transcript), 'main', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, records] of Object.entries(agents ?? {})) fs.writeFileSync(path.join(dir, name), jsonl(records(repo)));
    for (const name of unreadable) fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, name));
  }
  const body = stdin ?? JSON.stringify({ transcript_path: transcript, ...input });
  return execFileSync('python3', [HOOK_PATH], { input: body, cwd: repo, encoding: 'utf8', env });
}

test('review-classify unreviewed source lines', async (t) => {
  const planEdit = (repo) => editOf(path.join(repo, 'plan.md'), 'step one', { at: stamp(0) });
  const mainOnly = (repo) => [planEdit(repo)];

  await t.test('a subagent transcript writes 30 source lines: code-added counts them and code-reviewer is required', () => {
    const out = classifyTranscript({ main: mainOnly, agents: { 'agent-a1.jsonl': (repo) => [writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) })] } });
    assert.match(out, / code-added=30 required=code-reviewer /);
  });

  await t.test('quiet: the same main transcript with no subagents directory counts nothing', () => {
    assert.match(classifyTranscript({ main: mainOnly }), / code-added=0 required=none /);
  });

  const written = (file, content) => (repo) => [writeOf(path.join(repo, file), content, { at: stamp(1) })];

  await t.test('a catch in the written source adds silent-failure-hunter to required', () => {
    const out = classifyTranscript({ main: written('impl.ts', sourceLines(30, withCatch)) });
    assert.match(out, / required=code-reviewer,silent-failure-hunter /);
  });

  await t.test('quiet: the same catch in a test file leaves code-reviewer alone', () => {
    const out = classifyTranscript({ main: written('impl.test.ts', sourceLines(30, withCatch)) });
    assert.match(out, / code-added=30 required=code-reviewer /);
  });

  await t.test('quiet: a 5-line source with a catch is under the floor', () => {
    const out = classifyTranscript({ main: written('impl.ts', sourceLines(5, withCatch)) });
    assert.match(out, / code-added=5 required=none /);
  });

  await t.test('required reads the text since the review while lenses keeps the whole session', () => {
    const out = classifyTranscript({
      onDisk: { 'first.ts': sourceLines(30, withCatch) },
      main: (repo) => [
        writeOf(path.join(repo, 'first.ts'), sourceLines(30, withCatch), { at: stamp(1) }),
        dispatchOf('code-reviewer', { id: 'review', at: stamp(2) }),
        writeOf(path.join(repo, 'second.ts'), sourceLines(25), { at: stamp(3) }),
      ],
    });
    assert.match(out, / code-added=25 required=code-reviewer /);
    assert.match(out, / lenses=\S*silent-failure-hunter /);
  });

  await t.test('a comment-only change of 30 lines requires nothing', () => {
    const comments = Array.from({ length: 30 }, (_, i) => `// note ${i}`).join('\n') + '\n';
    const out = classifyTranscript({ commit: { 'a.ts': 'export const a = 1;\n' }, onDisk: { 'a.ts': `export const a = 1;\n${comments}` }, main: written('a.ts', comments) });
    assert.match(out, / lenses=comment-analyzer /);
    assert.match(out, / required=none /);
  });

  await t.test('quiet: the same 30 lines as code keep code-reviewer required', () => {
    const code = sourceLines(30);
    const out = classifyTranscript({ commit: { 'a.ts': 'export const a = 1;\n' }, onDisk: { 'a.ts': `export const a = 1;\n${code}` }, main: written('a.ts', code) });
    assert.match(out, / required=code-reviewer /);
  });

  const reviewed = (subagentType, { error = false, id = 'review' } = {}) => (repo) => [
    writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) }),
    ...(subagentType ? [dispatchOf(subagentType, { id, at: stamp(2) }), ...(error ? [resultOf(id, { error, at: stamp(2) })] : [])] : []),
    editOf(path.join(repo, 'impl.ts'), sourceLines(5), { at: stamp(3) }),
  ];

  await t.test('review point: only the lines after a code-reviewer dispatch count', () => {
    assert.match(classifyTranscript({ main: reviewed('code-reviewer') }), / code-added=5 required=none /);
  });

  await t.test('review point: a plugin prefix on the dispatch is stripped', () => {
    assert.match(classifyTranscript({ main: reviewed('pr-review-toolkit:code-reviewer') }), / code-added=5 required=none /);
  });

  await t.test('review point: a dispatch under the older Task tool name counts too', () => {
    const main = (repo) => [
      writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) }),
      toolCall('Task', { subagent_type: 'code-reviewer', prompt: 'review' }, { id: 'review', at: stamp(2) }),
      editOf(path.join(repo, 'impl.ts'), sourceLines(5), { at: stamp(3) }),
    ];
    assert.match(classifyTranscript({ main }), / code-added=5 required=none /);
  });

  const twins = [
    ['no dispatch', reviewed(null), {}],
    ['a dispatch with an errored result', reviewed('code-reviewer', { error: true }), {}],
    ['a silent-failure-hunter dispatch', reviewed('silent-failure-hunter'), {}],
    ['a dispatch stamped at the review cutoff', reviewed('code-reviewer'), { review_cutoff: stamp(2) }],
  ];
  for (const [name, main, input] of twins) {
    await t.test(`review point twin: ${name} leaves all 35 lines counted`, () => {
      assert.match(classifyTranscript({ main, input }), / code-added=35 /);
    });
  }

  await t.test('SINCE is the first top-level timestamp, not a nested one', () => {
    const out = classifyTranscript({
      commit: { 'a.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' },
      main: () => [{ type: 'user', snapshot: { timestamp: stamp(0) } }, { type: 'user', timestamp: '2020-01-01T00:00:00.000Z' }],
    });
    assert.match(out, / added=3 /);
  });

  await t.test('a record of another type holding the Write block adds nothing', () => {
    const block = (type) => (repo) => [planEdit(repo), writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { type })];
    assert.match(classifyTranscript({ main: block('user') }), / code-added=0 /);
    assert.match(classifyTranscript({ main: block('assistant') }), / code-added=30 /);
  });

  await t.test('a Write whose result is an error adds no lines but keeps its file in scope', () => {
    const run = (error) => classifyTranscript({
      onDisk: { 'a.ts': sourceLines(3), 'b.ts': sourceLines(40) },
      main: (repo) => [writeOf(path.join(repo, 'a.ts'), sourceLines(30), { id: 'w1', at: stamp(1) }), resultOf('w1', { error, at: stamp(2) })],
    });
    assert.match(run(true), / code-added=0 .* added=3 /);
    assert.match(run(false), / code-added=30 /);
  });

  await t.test('a Write under an unresolved spelling of the repo path counts; a path outside the repo does not', (sub) => {
    if (fs.realpathSync(tmpDir) === tmpDir) return sub.skip('tmpDir has no symlink in its path here, so the two spellings are equal');
    const spelled = (dir, file) => (repo) => [planEdit(repo), writeOf(path.join(tmpDir, dir ?? path.basename(repo), file), sourceLines(30), { at: stamp(1) })];
    assert.match(classifyTranscript({ main: spelled(null, 'impl.ts') }), / code-added=30 /);
    assert.match(classifyTranscript({ main: spelled('elsewhere', 'impl.ts') }), / code-added=0 /);
  });

  const strayString = (repo) => ({ type: 'assistant', timestamp: stamp(0), message: { content: ['stray', { type: 'tool_use', id: 'note', name: 'Edit', input: { file_path: path.join(repo, 'notes.md'), old_string: 'a', new_string: 'b' } }] } });

  await t.test('a string inside a content list does not drop the Write beside it', () => {
    assert.match(classifyTranscript({ main: (repo) => [strayString(repo), writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) })] }), / code-added=30 /);
    assert.match(classifyTranscript({ main: (repo) => [strayString(repo)] }), / code-added=0 /);
  });

  await t.test('an unreadable subagent transcript does not drop the one beside it', () => {
    const write = (repo) => [writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) })];
    assert.match(classifyTranscript({ main: mainOnly, agents: { 'agent-b.jsonl': write }, unreadable: ['agent-a.jsonl'] }), / code-added=30 /);
    assert.match(classifyTranscript({ main: mainOnly, unreadable: ['agent-a.jsonl'] }), / code-added=0 /);
  });

  await t.test('empty stdin exits 0', () => {
    assert.doesNotThrow(() => classifyTranscript({ stdin: '' }));
  });
});

test('review-classify on bytes outside ASCII', async (t) => {
  await t.test('an edited path holding U+00C5 still prints its joins line', () => {
    const name = 'Årsrapport.ts';
    const files = { [name]: ['export const a = 1;\n', 'export const a = b ?? 1;\n'] };
    // The collation crash this guards only exists under a UTF-8 locale.
    const out = joinsForEdit({ files, locale: 'en_US.UTF-8', payload: (repo) => ({ tool_input: { file_path: path.join(repo, name) } }) });
    assert.match(out, /lenses=\S*silent-failure-hunter/);
  });

  await t.test('a package.json with an invalid UTF-8 byte still yields its test script', () => {
    const manifest = Buffer.from('{"author":"Jos\xe9","scripts":{"test":"vitest"}}', 'latin1');
    const files = { 'package.json': [manifest, manifest], 'a.ts': ['', 'export const a = 1;\n'] };
    assert.match(joinsForEdit({ files }), /lenses=\S*pr-test-analyzer/);
  });

  await t.test('a comment indented with a Unicode space is not a comment-only change', () => {
    const files = { 'a.ts': ['export const a = 1;\n', 'export const a = 1;\n // note\n'] };
    assert.match(joinsForEdit({ files }), /lenses=reuse-analyzer/);
  });
});
