'use strict';

const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', '..', 'hooks', 'review-classify.py');

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

function joinsFor(prompt, { source } = {}) {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (source !== undefined) fs.writeFileSync(path.join(repo, 'src.ts'), source);
  return execFileSync('python3', [HOOK_PATH], { input: JSON.stringify({ prompt }), cwd: repo, encoding: 'utf8' });
}

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

module.exports = {
  HOOK_PATH,
  tmpDir,
  env,
  lensesFor,
  joinsForEdit,
  cases,
  joinsFor,
  stamp,
  sourceLines,
  withCatch,
  toolCall,
  writeOf,
  editOf,
  dispatchOf,
  resultOf,
  classifyTranscript,
};
