'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  tmpDir, stamp, sourceLines, withCatch, toolCall, writeOf, editOf, dispatchOf, resultOf, classifyTranscript,
  written, plainRun, linkedRun, reviewer, required, owedFor, four, bigFive, bigSix, bigFiveWithout,
} = require('./helpers/review-classify');

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

  await t.test('a catch in the written source adds silent-failure-hunter to required', () => {
    const out = classifyTranscript({ main: written('impl.ts', sourceLines(30, withCatch)) });
    assert.match(out, / required=code-reviewer,silent-failure-hunter /);
  });

  await t.test('quiet: the same catch in a test file owes nothing, code-reviewer included', () => {
    const out = classifyTranscript({ main: written('impl.test.ts', sourceLines(30, withCatch)) });
    assert.match(out, / code-added=0 required=none /);
  });

  await t.test('quiet: a 5-line source with a catch is under the floor', () => {
    const out = classifyTranscript({ main: written('impl.ts', sourceLines(5, withCatch)) });
    assert.match(out, / code-added=5 required=none /);
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
    assert.doesNotMatch(out, / lenses=comment-analyzer /);
    assert.match(out, / required=code-reviewer /);
  });

  const ab = { 'a.ts': sourceLines(30), 'b.ts': sourceLines(25) };
  const coverage = (secondShown, input) => classifyTranscript({
    onDisk: ab,
    input,
    main: (repo) => [
      writeOf(path.join(repo, 'a.ts'), ab['a.ts'], { at: stamp(1) }),
      ...linkedRun('code-reviewer', { id: 'run1', agent: 'r1', at: 2 }),
      writeOf(path.join(repo, 'b.ts'), ab['b.ts'], { at: stamp(3) }),
      ...(secondShown ? linkedRun('code-reviewer', { id: 'run2', agent: 'r2', at: 5 }) : []),
    ],
    agents: { ...reviewer(['a.ts'], { agent: 'r1' }), ...(secondShown ? reviewer(secondShown, { agent: 'r2' }) : {}) },
  });

  await t.test('coverage: 30 lines in a.ts shown to a code-reviewer run, then 25 in b.ts, leave code-reviewer required for b.ts', () => {
    const out = coverage(null);
    assert.match(out, / code-added=25 required=code-reviewer /);
    assert.equal(owedFor(out, 'code-reviewer'), 'b.ts');
  });

  await t.test('coverage: a later code-reviewer run not shown b.ts leaves it listed', () => {
    const out = coverage(['a.ts']);
    assert.match(out, / code-added=25 required=code-reviewer /);
    assert.equal(owedFor(out, 'code-reviewer'), 'b.ts');
  });

  await t.test('coverage: a later run shown b.ts clears it, with a review_cutoff earlier than that run in the payload', () => {
    assert.match(coverage(['b.ts'], { review_cutoff: stamp(4) }), / code-added=0 required=none /);
  });

  await t.test('coverage twin: the same later run with no review_cutoff clears it too', () => {
    assert.match(coverage(['b.ts']), / code-added=0 required=none /);
  });

  await t.test('coverage: 30 reviewed lines in a.ts plus 5 new owe 5, not 35', () => {
    const out = classifyTranscript({
      onDisk: { 'a.ts': sourceLines(35) },
      main: (repo) => [
        writeOf(path.join(repo, 'a.ts'), sourceLines(30), { at: stamp(1) }),
        ...linkedRun('code-reviewer', { at: 2 }),
        editOf(path.join(repo, 'a.ts'), sourceLines(5), { at: stamp(3) }),
      ],
      agents: reviewer(['a.ts']),
    });
    assert.match(out, / code-added=5 required=none /);
  });

  const reviewed = (subagentType, { error = false, id = 'review', tool = 'Agent', result = true } = {}) => (repo) => [
    writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) }),
    ...(subagentType ? [toolCall(tool, { subagent_type: subagentType, description: 'review', prompt: 'review' }, { id, at: stamp(2) }), ...(result ? [resultOf(id, { error, at: stamp(2) })] : [])] : []),
    editOf(path.join(repo, 'impl.ts'), sourceLines(5), { at: stamp(3) }),
  ];

  await t.test('review run: only the lines written after a finished code-reviewer run count', () => {
    assert.match(classifyTranscript({ main: reviewed('code-reviewer') }), / code-added=5 required=none /);
  });

  await t.test('review run: a plugin prefix on the dispatch is stripped', () => {
    assert.match(classifyTranscript({ main: reviewed('pr-review-toolkit:code-reviewer') }), / code-added=5 required=none /);
  });

  await t.test('review run: a dispatch under the older Task tool name counts too', () => {
    assert.match(classifyTranscript({ main: reviewed('code-reviewer', { tool: 'Task' }) }), / code-added=5 required=none /);
  });

  const twins = [
    ['no dispatch', reviewed(null)],
    ['a dispatch with an errored result', reviewed('code-reviewer', { error: true })],
    ['a dispatch with no result yet', reviewed('code-reviewer', { result: false })],
    ['a silent-failure-hunter run', reviewed('silent-failure-hunter')],
  ];
  for (const [name, main] of twins) {
    await t.test(`review run twin: ${name} leaves all 35 lines counted`, () => {
      assert.match(classifyTranscript({ main }), / code-added=35 /);
    });
  }

  await t.test('a review_cutoff in the payload moves no run: the run at the cutoff still clears', () => {
    assert.match(classifyTranscript({ main: reviewed('code-reviewer'), input: { review_cutoff: stamp(2) } }), / code-added=5 /);
  });

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

  await t.test('big: 250 source lines list code-reviewer and the four Big members, never security-review', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(250)) }), bigFive);
  });

  await t.test('big: 200 source lines reach the Big rule', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(200)) }), bigFive);
  });

  await t.test('quiet: 199 source lines list code-reviewer alone', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(199)) }), / code-added=199 required=code-reviewer /);
  });

  await t.test('quiet: 200 lines in impl.test.ts list nothing', () => {
    assert.match(classifyTranscript({ main: written('impl.test.ts', sourceLines(200)) }), / code-added=0 required=none /);
  });

  await t.test('quiet: 200 lines in e2e/tests/flow.ts list nothing', () => {
    assert.match(classifyTranscript({ main: written('e2e/tests/flow.ts', sourceLines(200)) }), / code-added=0 required=none /);
  });

  await t.test('quiet: 30 lines under src/tests/ list nothing', () => {
    assert.match(classifyTranscript({ main: written('src/tests/flow.ts', sourceLines(30)) }), / code-added=0 required=none /);
  });

  await t.test('quiet: three new 10-line source files are bulk but list code-reviewer alone', () => {
    const names = ['one.ts', 'two.ts', 'three.ts'];
    const out = classifyTranscript({
      onDisk: Object.fromEntries(names.map((name) => [name, sourceLines(10)])),
      main: (repo) => names.map((name, i) => writeOf(path.join(repo, name), sourceLines(10), { at: stamp(i + 1) })),
    });
    assert.match(out, / bulk=yes code-added=30 required=code-reviewer /);
  });

  await t.test('big: 25 lines in src/useAuth.ts, a risk path, add security-review to the five', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.ts', sourceLines(25)) }), bigSix);
  });

  await t.test('quiet: 10 lines in src/useAuth.ts are under the floor', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.ts', sourceLines(10)) }), / required=none /);
  });

  await t.test('quiet: 25 lines in src/useAuth.test.ts list nothing', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.test.ts', sourceLines(25)) }), / code-added=0 required=none /);
  });

  await t.test('big: 200 lines holding a catch list silent-failure-hunter once', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(200, withCatch)) }), bigFive);
  });

  await t.test('delete-list and reuse-analyzer leave required but stay in lenses on 300 bulk lines', () => {
    const out = classifyTranscript({ onDisk: { 'impl.ts': sourceLines(300) }, main: written('impl.ts', sourceLines(300)) });
    assert.match(out, bigFive);
    assert.match(out, / lenses=\S*reuse-analyzer\S*delete-list/);
  });

  const lensFile = [
    '// first',
    '// second',
    '// third',
    'var legacy = 1;',
    ...Array.from({ length: 26 }, (_, i) => `export const v${i} = ${i};`),
  ].join('\n') + '\n';

  await t.test('signals: 30 code lines holding 3 comment lines and a legacy var join lenses; comment-analyzer is required, modern-ts-analyzer is not', () => {
    const out = classifyTranscript({ onDisk: { 'impl.ts': lensFile }, main: written('impl.ts', lensFile) });
    assert.match(out, / lenses=\S*comment-analyzer/);
    assert.match(out, / lenses=\S*modern-ts-analyzer/);
    assert.match(out, / required=code-reviewer,comment-analyzer /);
  });

  const afterBig = (...records) => (repo) => [writeOf(path.join(repo, 'impl.ts'), sourceLines(200), { at: stamp(1) }), ...records.flat()];

  await t.test('a code-reviewer run clears none of the Big members', () => {
    const out = classifyTranscript({
      main: (repo) => [
        ...afterBig(plainRun('code-reviewer'))(repo),
        editOf(path.join(repo, 'impl.ts'), sourceLines(5), { at: stamp(3) }),
      ],
    });
    assert.match(out, / code-added=5 /);
    assert.match(out, required(four));
  });

  await t.test('big: a placement-analyzer run after 200 lines clears placement-analyzer alone', () => {
    assert.match(classifyTranscript({ main: afterBig(plainRun('placement-analyzer')) }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('big: a silent-failure-hunter run after 200 lines clears silent-failure-hunter alone', () => {
    assert.match(classifyTranscript({ main: afterBig(plainRun('silent-failure-hunter')) }), bigFiveWithout('silent-failure-hunter'));
  });

  await t.test('big: a silent-failure-hunter run after 200 catch lines clears its signal with its lines', () => {
    const out = classifyTranscript({
      main: (repo) => [writeOf(path.join(repo, 'impl.ts'), sourceLines(200, withCatch), { at: stamp(1) }), ...plainRun('silent-failure-hunter')],
    });
    assert.match(out, bigFiveWithout('silent-failure-hunter'));
  });

  await t.test('big: 200 more lines after a placement-analyzer run list placement-analyzer again', () => {
    const out = classifyTranscript({
      main: (repo) => [...afterBig(plainRun('placement-analyzer'))(repo), writeOf(path.join(repo, 'more.ts'), sourceLines(200), { at: stamp(3) })],
    });
    assert.match(out, bigFive);
  });

  const unclearing = [
    ['an errored result', afterBig(plainRun('placement-analyzer', { error: true }))],
    ['no result yet', afterBig([dispatchOf('placement-analyzer', { id: 'run', at: stamp(2) })])],
    ['a run before the writes', (repo) => [...plainRun('placement-analyzer', { at: 0 }), ...afterBig()(repo)]],
  ];
  for (const [name, main] of unclearing) {
    await t.test(`big twin: a placement-analyzer run with ${name} keeps placement-analyzer listed`, () => {
      assert.match(classifyTranscript({ main }), bigFive);
    });
  }

  await t.test('big twin: a review_cutoff earlier than the run does not keep placement-analyzer listed', () => {
    assert.match(classifyTranscript({ main: afterBig(plainRun('placement-analyzer')), input: { review_cutoff: stamp(2) } }), bigFiveWithout('placement-analyzer'));
  });

  const afterRisk = (...records) => (repo) => [writeOf(path.join(repo, 'src/useAuth.ts'), sourceLines(25), { at: stamp(1) }), ...records.flat()];

  await t.test('skill member: a main-thread Skill security-review call after 25 lines in a risk path drops it from required and owed-files', () => {
    const before = classifyTranscript({ main: afterRisk() });
    assert.match(before, bigSix);
    assert.equal(owedFor(before, 'security-review'), 'src/useAuth.ts');
    const out = classifyTranscript({ main: afterRisk(plainRun('security-review')) });
    assert.match(out, bigFive);
    assert.equal(owedFor(out, 'security-review'), undefined);
    assert.equal(owedFor(out, 'adversarial-reviewer'), 'src/useAuth.ts');
    assert.match(classifyTranscript({ main: afterRisk([toolCall('Skill', { skill: 'plugin:security-review' }, { id: 'run', at: stamp(2) }), resultOf('run')]) }), bigFive);
  });

  const skillTwins = [
    ['an Agent dispatch named security-review', afterRisk([dispatchOf('security-review', { id: 'run', at: stamp(2) }), resultOf('run')])],
    ['a Skill call before the writes', (repo) => [...plainRun('security-review', { at: 0 }), ...afterRisk()(repo)]],
    ['a Skill call with an errored result', afterRisk(plainRun('security-review', { error: true }))],
    ['a Skill call with no result yet', afterRisk([toolCall('Skill', { skill: 'security-review' }, { id: 'run', at: stamp(2) })])],
    ['a Skill call named for an agent member', afterRisk([toolCall('Skill', { skill: 'placement-analyzer' }, { id: 'run', at: stamp(2) }), resultOf('run')])],
  ];
  for (const [name, main] of skillTwins) {
    await t.test(`skill member twin: ${name} leaves security-review listed and owed`, () => {
      const out = classifyTranscript({ main });
      assert.match(out, bigSix);
      assert.equal(owedFor(out, 'security-review'), 'src/useAuth.ts');
    });
  }

  await t.test('skill member twin: a Skill call inside a subagent clears nothing', () => {
    const out = classifyTranscript({ main: afterRisk(), agents: { 'agent-s1.jsonl': () => plainRun('security-review') } });
    assert.match(out, bigSix);
    assert.equal(owedFor(out, 'security-review'), 'src/useAuth.ts');
  });
});
