'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'hydrogen-context.sh');
const HYDROGEN_REF = path.resolve(__dirname, '..', 'hydrogen-reference.md');
const FLAG_PREFIX = `claude-hydrogen-ctx-theme-ctx-test-${process.pid}-`;

let seq = 0;
const newSession = () => `theme-ctx-test-${process.pid}-${seq++}`;

function repoWith(dependency) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-ctx-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [dependency]: '1.0.2' } }));
  return dir;
}

const themedRepo = repoWith('@additiv-hydrogen/ui.theme');
const plainRepo = repoWith('react');

test.after(() => {
  for (const name of fs.readdirSync('/tmp')) {
    if (name.startsWith(FLAG_PREFIX)) fs.rmSync(path.join('/tmp', name), { force: true });
  }
  fs.rmSync(themedRepo, { recursive: true, force: true });
  fs.rmSync(plainRepo, { recursive: true, force: true });
});

function run(input) {
  const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8', env: { ...process.env, HYDROGEN_REF } });
  assert.equal(res.status, 0);
  return res.stdout;
}

const callNaming = (sessionId, cwd, pattern) =>
  JSON.stringify({ session_id: sessionId, cwd, tool_name: 'Grep', tool_input: { pattern } });

const call = (sessionId, cwd) => callNaming(sessionId, cwd, 'getColor');

const OUTPUT_CEILING = 9800;

const SECTIONS = [
  { heading: '## Ejection', symbol: 'ejected' },
  { heading: '## Layouts', symbol: 'StepContent' },
  { heading: '## Workflows', symbol: 'useProcessState' },
  { heading: '## Data & caching', symbol: 'staleTime' },
  { heading: '## Theming', symbol: 'getColor' },
  { heading: '## Tables', symbol: 'useTableControl' },
  { heading: '## Forms', symbol: 'HydrogenForms' },
];
const ALL_SYMBOLS = SECTIONS.map((section) => section.symbol).join(' ');

const headingWord = (section) => section.heading.slice(3).split(' ')[0];

function sectionText(section) {
  const lines = fs.readFileSync(HYDROGEN_REF, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(section.heading));
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start, next === -1 ? undefined : next).join('\n').trimEnd();
}

const contextOf = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext;
const sectionsIn = (context) =>
  SECTIONS.filter((section) => context.split('\n').some((line) => line.startsWith(section.heading)));
const leftOutNames = (context) => {
  const closing = context.match(/left out[^:]*: ([^.]+)\./);
  return closing ? closing[1].split(', ') : [];
};

test('hydrogen context hook', async (t) => {
  await t.test('a call naming getColor injects the Theming section once', () => {
    const sessionId = newSession();
    assert.match(run(call(sessionId, themedRepo)), /## Theming/);
    assert.equal(run(call(sessionId, themedRepo)), '');
  });

  await t.test('a call in a repo without Hydrogen injects nothing', () => {
    assert.equal(run(call(newSession(), plainRepo)), '');
  });

  await t.test('an empty payload passes with no output', () => {
    assert.equal(run(''), '');
  });

  await t.test('a call naming all seven sections stays under the ceiling with whole sections and a closing line', () => {
    const out = run(callNaming(newSession(), themedRepo, ALL_SYMBOLS));
    assert.ok(Buffer.byteLength(out) < OUTPUT_CEILING, `emits ${Buffer.byteLength(out)} bytes, ceiling ${OUTPUT_CEILING}`);
    const context = contextOf(out);
    const present = sectionsIn(context);
    assert.ok(present.length > 0);
    for (const section of present) assert.ok(context.includes(sectionText(section)), `${section.heading} is cut`);
    assert.ok(!context.includes('## hera pointers'));
    const absent = SECTIONS.filter((section) => !present.includes(section)).map(headingWord);
    assert.deepEqual(leftOutNames(context), absent);
  });

  await t.test('repeating the all-seven call delivers every section exactly once, then goes silent', () => {
    const sessionId = newSession();
    const outputs = [];
    for (let round = 0; round < 7; round++) {
      const out = run(callNaming(sessionId, themedRepo, ALL_SYMBOLS));
      if (out === '') break;
      assert.ok(Buffer.byteLength(out) < OUTPUT_CEILING, `round ${round + 1} emits ${Buffer.byteLength(out)} bytes, ceiling ${OUTPUT_CEILING}`);
      outputs.push(contextOf(out));
    }
    assert.equal(run(callNaming(sessionId, themedRepo, ALL_SYMBOLS)), '');
    for (const section of SECTIONS) {
      const holders = outputs.filter((context) => sectionsIn(context).includes(section));
      assert.equal(holders.length, 1, `${section.heading} appears in ${holders.length} outputs`);
    }
  });

  for (const section of SECTIONS) {
    await t.test(`${section.symbol} alone injects ${headingWord(section)} under the ceiling with no closing line`, () => {
      const out = run(callNaming(newSession(), themedRepo, section.symbol));
      assert.notEqual(out, '');
      assert.ok(Buffer.byteLength(out) < OUTPUT_CEILING, `emits ${Buffer.byteLength(out)} bytes, ceiling ${OUTPUT_CEILING}`);
      assert.deepEqual(leftOutNames(contextOf(out)), []);
    });
  }
});
