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

  const skillMembers = ['security-review'];
  const runCall = (member, opts) => (skillMembers.includes(member) ? toolCall('Skill', { skill: member }, opts) : dispatchOf(member, opts));
  const plainRun = (member, { id = 'run', at = 2, error = false } = {}) => [runCall(member, { id, at: stamp(at) }), resultOf(id, { error, at: stamp(at) })];
  const linkedRun = (member, { id = 'run', agent = 'r1', at = 2 } = {}) => [
    runCall(member, { id, at: stamp(at) }),
    resultOf(id, { at: stamp(at), content: [{ type: 'text', text: skillMembers.includes(member) ? 'Launching skill' : `done\nagentId: ${agent} (use SendMessage to continue)` }] }),
  ];
  const attachment = (body) => ({ type: 'attachment', attachment: body });
  const reviewer = (shown, { agent = 'r1', brief = 'review the change', blob = brief, instructions = 'house rules', gitStatus = 'clean', after = [] } = {}) => ({
    [`agent-${agent}.jsonl`]: () => [
      { type: 'user', message: { role: 'user', content: brief } },
      { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>\nYour final report goes through the handback tool.\n</system-reminder>' } },
      attachment({ type: 'instructions', files: [{ path: '/home/CLAUDE.md', type: 'User', content: instructions }] }),
      attachment({ type: 'session_context', context: { gitStatus } }),
      { type: 'api-request-blob', hash: 'h1', message: { role: 'user', content: [{ type: 'text', text: blob }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `opened ${shown.join(' ')}` }] } },
      ...after,
    ],
  });

  const required = (members) => new RegExp(` required=${members.join(',')} `);
  const owedFor = (out, member) => (out.match(/ owed-files=([^\s>]*)>/)?.[1] ?? '').split(';').find((entry) => entry.startsWith(`${member}:`))?.slice(member.length + 1);
  const four = ['silent-failure-hunter', 'type-design-analyzer', 'placement-analyzer', 'adversarial-reviewer'];
  const bigFive = required(['code-reviewer', ...four]);
  const bigSix = required(['code-reviewer', ...four, 'security-review']);
  const bigFiveWithout = (member) => required(['code-reviewer', ...four.filter((m) => m !== member)]);

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

  await t.test('signals: 30 code lines holding 3 comment lines and a legacy var join lenses, not required', () => {
    const out = classifyTranscript({ onDisk: { 'impl.ts': lensFile }, main: written('impl.ts', lensFile) });
    assert.match(out, / lenses=\S*comment-analyzer/);
    assert.match(out, / lenses=\S*modern-ts-analyzer/);
    assert.match(out, / required=code-reviewer /);
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

  const backgroundRun = (member, { id = 'run', agent = 'r1', at = 2 } = {}) => [
    toolCall('Agent', { subagent_type: member, description: 'review', prompt: 'review', run_in_background: true }, { id, at: stamp(at) }),
    resultOf(id, { at: stamp(at), content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agent} (internal ID)\nThe agent is working in the background.` }] }),
  ];
  const noticeText = (id, status = 'completed', agent = 'r1') => `<task-notification>\n<task-id>${agent}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/${agent}.output</output-file>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  const noticeRecord = (id, status) => ({ type: 'user', timestamp: stamp(6), message: { role: 'user', content: noticeText(id, status) } });
  const noticeAttachment = (id) => attachment({ type: 'queued_command', commandMode: 'task-notification', prompt: noticeText(id) });
  const backgroundCoverage = (...after) => classifyTranscript({
    onDisk: { 'a.ts': sourceLines(30) },
    main: (repo) => [writeOf(path.join(repo, 'a.ts'), sourceLines(30), { at: stamp(1) }), ...backgroundRun('code-reviewer'), ...after],
    agents: reviewer(['a.ts']),
  });

  await t.test('background: a code-reviewer launch with no completion notification clears nothing', () => {
    assert.match(backgroundCoverage(), / code-added=30 required=code-reviewer /);
  });

  await t.test('background: a completed notification record clears it', () => {
    assert.match(backgroundCoverage(noticeRecord('run')), / code-added=0 required=none /);
  });

  await t.test('background: a completed notification delivered as a queued attachment clears it', () => {
    assert.match(backgroundCoverage(noticeAttachment('run')), / code-added=0 required=none /);
  });

  const noClear = [
    ['a failed notification', noticeRecord('run', 'failed')],
    ['a killed notification', noticeRecord('run', 'killed')],
    ['a notification for another call', noticeRecord('other')],
    ['a typed prompt quoting a notification', { type: 'user', timestamp: stamp(6), message: { role: 'user', content: `look at this: ${noticeText('run')}` } }],
  ];
  for (const [name, record] of noClear) {
    await t.test(`background twin: ${name} clears nothing`, () => {
      assert.match(backgroundCoverage(record), / code-added=30 required=code-reviewer /);
    });
  }

  const rewordedLaunch = (background) => classifyTranscript({
    onDisk: { 'a.ts': sourceLines(30) },
    main: (repo) => [
      writeOf(path.join(repo, 'a.ts'), sourceLines(30), { at: stamp(1) }),
      toolCall('Agent', { subagent_type: 'code-reviewer', description: 'review', prompt: 'review', ...(background && { run_in_background: true }) }, { id: 'run', at: stamp(2) }),
      resultOf('run', { at: stamp(2), content: [{ type: 'text', text: 'Agent started.\nagentId: r1 (internal ID)' }] }),
    ],
    agents: reviewer(['a.ts']),
  });

  await t.test('background: run_in_background with a reworded launch text and no notification clears nothing', () => {
    assert.match(rewordedLaunch(true), / code-added=30 required=code-reviewer /);
  });

  await t.test('background twin: the same reworded launch without run_in_background clears the file', () => {
    assert.match(rewordedLaunch(false), / code-added=0 required=none /);
  });

  const resumeVia = (to) => [toolCall('SendMessage', { to, message: 'Continue the review where you stopped' }, { id: 'sm', at: stamp(4) }), resultOf('sm', { at: stamp(4) })];

  await t.test('background resume: a completed notification under the SendMessage id clears the failed run', () => {
    assert.match(backgroundCoverage(noticeRecord('run', 'failed'), ...resumeVia('r1'), noticeRecord('sm')), / code-added=0 required=none /);
  });

  const resumeNoClear = [
    ['a SendMessage to an agent that is not a reviewer', [noticeRecord('run', 'failed'), ...resumeVia('other'), noticeRecord('sm')]],
    ['a resumed run whose notification is failed', [noticeRecord('run', 'failed'), ...resumeVia('r1'), noticeRecord('sm', 'failed')]],
  ];
  for (const [name, after] of resumeNoClear) {
    await t.test(`background resume twin: ${name} clears nothing`, () => {
      assert.match(backgroundCoverage(...after), / code-added=30 required=code-reviewer /);
    });
  }

  const scoped = { review_scope: 'report' };

  await t.test('report scope: 250 lines no run covered list the four Big members and not code-reviewer', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(250)), input: scoped }), required(four));
  });

  await t.test('report scope: 30 lines holding a fallback signal list nothing', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(30, withCatch)), input: scoped }), / required=none /);
  });

  await t.test('report scope twin: the same 30 lines with no scope list code-reviewer and silent-failure-hunter', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(30, withCatch)) }), / required=code-reviewer,silent-failure-hunter /);
  });

  await t.test('report scope: 25 lines in a risk path list the four plus security-review', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.ts', sourceLines(25)), input: scoped }), required([...four, 'security-review']));
  });

  const writesThenRun = (files, member) => (repo) => [
    ...Object.entries(files).map(([name, content]) => writeOf(path.join(repo, name), content, { at: stamp(1) })),
    ...(member ? linkedRun(member) : []),
  ];
  const twoFiles = { 'a.ts': sourceLines(200), 'b.ts': sourceLines(200) };
  const placementRun = ({ files = twoFiles, onDisk = files, shown = ['a.ts'], ...rest } = {}) => classifyTranscript({ onDisk, main: writesThenRun(files, 'placement-analyzer'), agents: reviewer(shown), ...rest });

  await t.test('shown: a linked run that was shown a.ts only leaves placement-analyzer listed with b.ts owed', () => {
    const out = placementRun();
    assert.match(out, bigFive);
    assert.equal(owedFor(out, 'placement-analyzer'), 'b.ts');
  });

  const owesB = (out) => {
    assert.match(out, bigFive);
    assert.equal(owedFor(out, 'placement-analyzer'), 'b.ts');
  };

  await t.test('shown: a path named only in the reviewer brief does not clear its file', () => {
    owesB(placementRun({ agents: reviewer(['a.ts'], { brief: 'review a.ts and b.ts' }) }));
  });

  await t.test('shown: a brief repeated in an api-request-blob record does not clear its file', () => {
    owesB(placementRun({ agents: reviewer(['a.ts'], { blob: 'review a.ts and b.ts' }) }));
  });

  await t.test('shown: an instructions attachment naming the path does not clear its file', () => {
    owesB(placementRun({ agents: reviewer(['a.ts'], { instructions: 'rules for b.ts' }) }));
  });

  await t.test('shown: a session_context gitStatus naming the path does not clear its file', () => {
    owesB(placementRun({ agents: reviewer(['a.ts'], { gitStatus: 'M b.ts' }) }));
  });

  await t.test('quiet: a path in a tool_result clears its file', () => {
    const agents = reviewer(['a.ts'], { after: [resultOf('t1', { content: [{ type: 'text', text: 'src listing: b.ts' }] })] });
    assert.match(placementRun({ agents }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('quiet: a run shown both paths drops placement-analyzer', () => {
    assert.match(placementRun({ shown: ['a.ts', 'b.ts'] }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('owed-files: code-reviewer names the files its run was not shown', () => {
    const files = { 'a.ts': sourceLines(200), 'b.ts': sourceLines(200) };
    const out = classifyTranscript({ onDisk: files, main: writesThenRun(files, 'code-reviewer'), agents: reviewer(['a.ts']) });
    assert.equal(owedFor(out, 'code-reviewer'), 'b.ts');
    assert.equal(owedFor(placementRun(), 'code-reviewer'), 'a.ts,b.ts');
  });

  const worktreeFiles = { '.claude/worktrees/wt/a.ts': sourceLines(200), '.claude/worktrees/wt/b.ts': sourceLines(200) };

  await t.test('quiet: files written in a worktree clear when the run names them by their path inside it', () => {
    assert.match(placementRun({ files: worktreeFiles, shown: ['a.ts', 'b.ts'] }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('shown: a worktree file the run never names stays owed under its worktree path', () => {
    const out = placementRun({ files: worktreeFiles, shown: ['a.ts'] });
    assert.match(out, bigFive);
    assert.equal(owedFor(out, 'placement-analyzer'), '.claude/worktrees/wt/b.ts');
  });

  await t.test('quiet: a file no longer on disk is cleared by the later run', () => {
    assert.match(placementRun({ onDisk: { 'a.ts': twoFiles['a.ts'] } }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('quiet: a run whose result holds no agentId clears both files', () => {
    const main = (repo) => [...writesThenRun(twoFiles)(repo), ...plainRun('placement-analyzer')];
    assert.match(classifyTranscript({ onDisk: twoFiles, main }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('quiet: a linked id with no agent-r1.jsonl clears both files', () => {
    assert.match(classifyTranscript({ onDisk: twoFiles, main: writesThenRun(twoFiles, 'placement-analyzer') }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('quiet: a linked id whose agent-r1.jsonl cannot be read clears both files', () => {
    assert.match(classifyTranscript({ onDisk: twoFiles, main: writesThenRun(twoFiles, 'placement-analyzer'), unreadable: ['agent-r1.jsonl'] }), bigFiveWithout('placement-analyzer'));
  });

  await t.test('quiet: 30 lines left unshown are under 200, so placement-analyzer is dropped while the members with no run stay', () => {
    const out = placementRun({ files: { 'a.ts': sourceLines(250), 'b.ts': sourceLines(30) } });
    assert.match(out, required(['code-reviewer', 'silent-failure-hunter', 'type-design-analyzer', 'adversarial-reviewer']));
  });

  await t.test('owed-files: seven owed files print the five largest, largest first, then +2', () => {
    const lineCounts = { 'f1.ts': 30, 'f2.ts': 40, 'f3.ts': 35, 'f4.ts': 50, 'f5.ts': 45, 'f6.ts': 32, 'f7.ts': 60 };
    const files = Object.fromEntries(Object.entries(lineCounts).map(([name, count]) => [name, sourceLines(count)]));
    const out = classifyTranscript({ onDisk: files, main: writesThenRun(files) });
    assert.equal(owedFor(out, 'placement-analyzer'), 'f7.ts,f4.ts,f5.ts,f2.ts,f3.ts,+2');
  });

  await t.test('owed-files: a path with a space is percent-encoded', () => {
    const files = { 'my file.ts': sourceLines(200) };
    assert.equal(owedFor(classifyTranscript({ onDisk: files, main: writesThenRun(files) }), 'placement-analyzer'), 'my%20file.ts');
  });

  await t.test('owed-files: a path holding the list delimiters and % is percent-encoded', () => {
    const files = { 'a,b;c:d+e%f.ts': sourceLines(200) };
    assert.equal(owedFor(classifyTranscript({ onDisk: files, main: writesThenRun(files) }), 'placement-analyzer'), 'a%2Cb%3Bc%3Ad%2Be%25f.ts');
  });

  await t.test('owed-files: a silent-failure-hunter run shown a.ts only leaves b.ts owed', () => {
    const files = { 'a.ts': sourceLines(200, withCatch), 'b.ts': sourceLines(200) };
    const out = classifyTranscript({ onDisk: files, main: writesThenRun(files, 'silent-failure-hunter'), agents: reviewer(['a.ts']) });
    assert.equal(owedFor(out, 'silent-failure-hunter'), 'b.ts');
  });

  await t.test('guard: a catch file shown to silent-failure-hunter is cleared with its signal and has no owed entry', () => {
    const files = { 'a.ts': sourceLines(200, withCatch) };
    const out = classifyTranscript({ onDisk: files, main: writesThenRun(files, 'silent-failure-hunter'), agents: reviewer(['a.ts']) });
    assert.match(out, bigFiveWithout('silent-failure-hunter'));
    assert.equal(owedFor(out, 'silent-failure-hunter'), undefined);
  });

  const catchThenPlain = (plain) => {
    const files = { 'a.ts': sourceLines(30, withCatch), 'b.ts': plain };
    return classifyTranscript({
      onDisk: files,
      main: (repo) => [
        writeOf(path.join(repo, 'a.ts'), files['a.ts'], { at: stamp(1) }),
        ...linkedRun('silent-failure-hunter', { at: 2 }),
        writeOf(path.join(repo, 'b.ts'), files['b.ts'], { at: stamp(3) }),
      ],
      agents: reviewer(['a.ts']),
    });
  };

  await t.test('signal: a catch in a file only silent-failure-hunter covered, then 25 plain lines elsewhere, leave code-reviewer alone', () => {
    assert.match(catchThenPlain(sourceLines(25)), / required=code-reviewer /);
  });

  await t.test('signal twin: the 25 lines elsewhere holding a catch list silent-failure-hunter again', () => {
    assert.match(catchThenPlain(sourceLines(25, withCatch)), / required=code-reviewer,silent-failure-hunter /);
  });

  const allRuns = (members, shown = ['impl.ts']) => ({
    main: (repo) => [
      writeOf(path.join(repo, 'impl.ts'), sourceLines(250), { at: stamp(1) }),
      ...members.flatMap((member, i) => linkedRun(member, { id: `run${i}`, agent: `r${i}`, at: 2 })),
    ],
    agents: Object.assign({}, ...members.map((member, i) => reviewer(typeof shown === 'function' ? shown(member) : shown, { agent: `r${i}` }))),
  });

  await t.test('guard: runs shown every file list nothing and print no owed-files', () => {
    const out = classifyTranscript({ onDisk: { 'impl.ts': sourceLines(250) }, ...allRuns(['code-reviewer', ...four]) });
    assert.match(out, / required=none /);
    assert.doesNotMatch(out, /owed-files=/);
  });

  await t.test('guard twin: one run not shown the file keeps that member listed with the file owed', () => {
    const out = classifyTranscript({ onDisk: { 'impl.ts': sourceLines(250) }, ...allRuns(['code-reviewer', ...four], (member) => (member === 'adversarial-reviewer' ? ['other.ts'] : ['impl.ts'])) });
    assert.match(out, / required=adversarial-reviewer /);
    assert.equal(owedFor(out, 'adversarial-reviewer'), 'impl.ts');
  });

  await t.test('guard: a comment-only change of 200 lines prints required=none and no owed-files', () => {
    const comments = Array.from({ length: 200 }, (_, i) => `// note ${i}`).join('\n') + '\n';
    const out = classifyTranscript({ commit: { 'a.ts': 'export const a = 1;\n' }, onDisk: { 'a.ts': `export const a = 1;\n${comments}` }, main: written('a.ts', comments) });
    assert.match(out, / required=none /);
    assert.doesNotMatch(out, /owed-files=/);
  });

  const committedBig = { 'impl.ts': sourceLines(250) };
  const noNetDiff = (extra) => classifyTranscript({ commit: committedBig, onDisk: committedBig, input: { review_base: 'HEAD' }, ...extra });

  await t.test('no scope: a review_base with an empty net diff still lists the members 250 uncleared lines owe', () => {
    const out = noNetDiff({ main: written('impl.ts', sourceLines(250)) });
    assert.match(out, bigFive);
    assert.equal(owedFor(out, 'placement-analyzer'), 'impl.ts');
  });

  await t.test('no scope twin: the same window with every member run and shown the file lists nothing', () => {
    const out = noNetDiff(allRuns(['code-reviewer', ...four]));
    assert.match(out, / required=none[ >]/);
    assert.doesNotMatch(out, /owed-files=/);
  });

  await t.test('a comment-only window diff over earlier uncleared code is still listed', () => {
    const code = sourceLines(250);
    const out = classifyTranscript({ commit: { 'impl.ts': code }, onDisk: { 'impl.ts': `${code}// note\n` }, input: { review_base: 'HEAD' }, main: written('impl.ts', code) });
    assert.match(out, / lenses=comment-analyzer /);
    assert.match(out, bigFive);
  });

  await t.test('a comment-only window diff twin: the same window with every member run and shown the file lists nothing', () => {
    const code = sourceLines(250);
    const out = classifyTranscript({ commit: { 'impl.ts': code }, onDisk: { 'impl.ts': `${code}// note\n` }, input: { review_base: 'HEAD' }, ...allRuns(['code-reviewer', ...four]) });
    assert.match(out, / lenses=comment-analyzer /);
    assert.match(out, / required=none /);
  });

  await t.test('guard: a scan that raises names the failure on stderr and prints no required=', () => {
    const stderr = [];
    const out = classifyTranscript({
      onDisk: { 'impl.ts': sourceLines(30) },
      main: (repo) => [[], writeOf(path.join(repo, 'impl.ts'), sourceLines(30), { at: stamp(1) })],
      stderr,
    });
    assert.match(out, / code-added=0 added=30 /);
    assert.doesNotMatch(out, /required=/);
    assert.match(stderr.join(''), /^review-classify scan failed: AttributeError/);
  });

  await t.test('guard twin: a scan that completes prints required= and nothing on stderr', () => {
    const stderr = [];
    const out = classifyTranscript({ onDisk: { 'impl.ts': sourceLines(30) }, main: written('impl.ts', sourceLines(30)), stderr });
    assert.match(out, / code-added=30 required=code-reviewer /);
    assert.equal(stderr.join(''), '');
  });

  await t.test('empty stdin exits 0', () => {
    assert.doesNotThrow(() => classifyTranscript({ stdin: '' }));
  });

  const styledSource = "export const A = () => <div className='p-4' />;\n";
  const audit = (at) => toolCall('Skill', { skill: 'impeccable:impeccable', args: 'audit a.tsx' }, { id: `audit-${at}`, at: stamp(at) });
  const joinsImpeccable = (main) => / lenses=[^ ]*impeccable/.test(classifyTranscript({ onDisk: { 'a.tsx': styledSource }, main }));

  await t.test('impeccable: a styled write with no audit in the session joins impeccable', () => {
    assert.ok(joinsImpeccable((repo) => [writeOf(path.join(repo, 'a.tsx'), styledSource, { at: stamp(1) })]));
  });

  await t.test('impeccable: an audit after the last styled write drops impeccable', () => {
    assert.ok(!joinsImpeccable((repo) => [writeOf(path.join(repo, 'a.tsx'), styledSource, { at: stamp(1) }), audit(2)]));
  });

  await t.test('impeccable: a styled write after the audit joins impeccable again', () => {
    assert.ok(joinsImpeccable((repo) => [audit(1), writeOf(path.join(repo, 'a.tsx'), styledSource, { at: stamp(2) })]));
  });

  await t.test('impeccable: a .less stylesheet written after the audit joins impeccable again', () => {
    assert.ok(joinsImpeccable((repo) => [audit(1), writeOf(path.join(repo, 'a.less'), '.a { color: red; }\n', { at: stamp(2) })]));
  });
});
