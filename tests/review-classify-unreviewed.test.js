'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, stamp, sourceLines, withCatch, toolCall, writeOf, editOf, dispatchOf, resultOf, classifyTranscript } = require('./helpers/review-classify');

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

  const bigFour = ['silent-failure-hunter', 'type-design-analyzer', 'reuse-analyzer', 'placement-analyzer'];
  const required = (members) => new RegExp(` required=${members.join(',')} `);
  const allFive = required(['code-reviewer', ...bigFour]);
  const allFiveWithout = (member) => required(['code-reviewer', ...bigFour.filter((m) => m !== member)]);

  await t.test('big: 200 source lines list all five members', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(200)) }), allFive);
  });

  await t.test('quiet: 199 source lines list code-reviewer alone', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(199)) }), / code-added=199 required=code-reviewer /);
  });

  await t.test('quiet: 200 lines in impl.test.ts list code-reviewer alone', () => {
    assert.match(classifyTranscript({ main: written('impl.test.ts', sourceLines(200)) }), / code-added=200 required=code-reviewer /);
  });

  await t.test('quiet: 200 lines in e2e/tests/flow.ts list code-reviewer alone', () => {
    assert.match(classifyTranscript({ main: written('e2e/tests/flow.ts', sourceLines(200)) }), / code-added=200 required=code-reviewer /);
  });

  await t.test('quiet: three new 10-line source files are bulk but list code-reviewer alone', () => {
    const names = ['one.ts', 'two.ts', 'three.ts'];
    const out = classifyTranscript({
      onDisk: Object.fromEntries(names.map((name) => [name, sourceLines(10)])),
      main: (repo) => names.map((name, i) => writeOf(path.join(repo, name), sourceLines(10), { at: stamp(i + 1) })),
    });
    assert.match(out, / bulk=yes code-added=30 required=code-reviewer /);
  });

  await t.test('big: 25 lines in src/useAuth.ts, a risk path, list all five members', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.ts', sourceLines(25)) }), allFive);
  });

  await t.test('quiet: 10 lines in src/useAuth.ts are under the floor', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.ts', sourceLines(10)) }), / required=none /);
  });

  await t.test('quiet: 25 lines in src/useAuth.test.ts list code-reviewer alone', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.test.ts', sourceLines(25)) }), / code-added=25 required=code-reviewer /);
  });

  await t.test('big: 200 lines holding a catch list all five, silent-failure-hunter once', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(200, withCatch)) }), allFive);
  });

  await t.test('a code-reviewer dispatch clears none of the Big members', () => {
    const out = classifyTranscript({
      main: (repo) => [
        writeOf(path.join(repo, 'impl.ts'), sourceLines(200), { at: stamp(1) }),
        dispatchOf('code-reviewer', { id: 'review', at: stamp(2) }),
        editOf(path.join(repo, 'impl.ts'), sourceLines(5), { at: stamp(3) }),
      ],
    });
    assert.match(out, / code-added=5 /);
    assert.match(out, required(bigFour));
  });

  const bigThenDispatch = (member, { error = false, at = stamp(2) } = {}) => (repo) => [
    writeOf(path.join(repo, 'impl.ts'), sourceLines(200), { at: stamp(1) }),
    dispatchOf(member, { id: 'big', at }),
    ...(error ? [resultOf('big', { error, at })] : []),
  ];

  await t.test('big: a reuse-analyzer dispatch after 200 lines clears reuse-analyzer alone', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('reuse-analyzer') }), allFiveWithout('reuse-analyzer'));
  });

  await t.test('big: a silent-failure-hunter dispatch after 200 lines clears silent-failure-hunter alone', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('silent-failure-hunter') }), allFiveWithout('silent-failure-hunter'));
  });

  await t.test('big: 200 more lines after a reuse-analyzer dispatch list reuse-analyzer again', () => {
    const out = classifyTranscript({
      main: (repo) => [...bigThenDispatch('reuse-analyzer')(repo), writeOf(path.join(repo, 'more.ts'), sourceLines(200), { at: stamp(3) })],
    });
    assert.match(out, allFive);
  });

  await t.test('big twin: a reuse-analyzer dispatch with an errored result keeps reuse-analyzer listed', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('reuse-analyzer', { error: true }) }), allFive);
  });

  await t.test('big twin: a reuse-analyzer dispatch stamped at the review cutoff keeps reuse-analyzer listed', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('reuse-analyzer'), input: { review_cutoff: stamp(2) } }), allFive);
  });

  await t.test('guard: a scan that raises still prints the joins line with nothing required', () => {
    const out = classifyTranscript({
      onDisk: { 'impl.ts': sourceLines(30) },
      main: (repo) => [[], writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) })],
    });
    assert.match(out, / code-added=0 required=none /);
  });

  await t.test('empty stdin exits 0', () => {
    assert.doesNotThrow(() => classifyTranscript({ stdin: '' }));
  });
});
