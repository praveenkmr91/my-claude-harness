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

  const bigSeven = ['silent-failure-hunter', 'type-design-analyzer', 'reuse-analyzer', 'placement-analyzer', 'delete-list', 'adversarial-reviewer', 'security-review'];
  const skillMembers = ['delete-list', 'security-review'];
  const runOf = (member, { id, at }) => (skillMembers.includes(member) ? toolCall('Skill', { skill: member }, { id, at }) : dispatchOf(member, { id, at }));
  const required = (members) => new RegExp(` required=${members.join(',')} `);
  const allEight = required(['code-reviewer', ...bigSeven]);
  const allEightWithout = (member) => required(['code-reviewer', ...bigSeven.filter((m) => m !== member)]);

  await t.test('big: 200 source lines list all eight members', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(200)) }), allEight);
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

  await t.test('big: 25 lines in src/useAuth.ts, a risk path, list all eight members', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.ts', sourceLines(25)) }), allEight);
  });

  await t.test('quiet: 10 lines in src/useAuth.ts are under the floor', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.ts', sourceLines(10)) }), / required=none /);
  });

  await t.test('quiet: 25 lines in src/useAuth.test.ts list code-reviewer alone', () => {
    assert.match(classifyTranscript({ main: written('src/useAuth.test.ts', sourceLines(25)) }), / code-added=25 required=code-reviewer /);
  });

  await t.test('big: 200 lines holding a catch list all eight, silent-failure-hunter once', () => {
    assert.match(classifyTranscript({ main: written('impl.ts', sourceLines(200, withCatch)) }), allEight);
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
    assert.match(out, required(bigSeven));
  });

  const bigThenDispatch = (member, { error = false } = {}) => (repo) => [
    writeOf(path.join(repo, 'impl.ts'), sourceLines(200), { at: stamp(1) }),
    dispatchOf(member, { id: 'big', at: stamp(2) }),
    ...(error ? [resultOf('big', { error, at: stamp(2) })] : []),
  ];

  await t.test('big: a reuse-analyzer dispatch after 200 lines clears reuse-analyzer alone', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('reuse-analyzer') }), allEightWithout('reuse-analyzer'));
  });

  await t.test('big: a silent-failure-hunter dispatch after 200 lines clears silent-failure-hunter alone', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('silent-failure-hunter') }), allEightWithout('silent-failure-hunter'));
  });

  await t.test('big: a silent-failure-hunter dispatch leaves its catch signal listed until code-reviewer runs', () => {
    const out = classifyTranscript({
      main: (repo) => [
        writeOf(path.join(repo, 'impl.ts'), sourceLines(200, withCatch), { at: stamp(1) }),
        dispatchOf('silent-failure-hunter', { id: 'big', at: stamp(2) }),
      ],
    });
    assert.match(out, allEight);
  });

  await t.test('big: 200 more lines after a reuse-analyzer dispatch list reuse-analyzer again', () => {
    const out = classifyTranscript({
      main: (repo) => [...bigThenDispatch('reuse-analyzer')(repo), writeOf(path.join(repo, 'more.ts'), sourceLines(200), { at: stamp(3) })],
    });
    assert.match(out, allEight);
  });

  await t.test('big twin: a reuse-analyzer dispatch with an errored result keeps reuse-analyzer listed', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('reuse-analyzer', { error: true }) }), allEight);
  });

  await t.test('big twin: a reuse-analyzer dispatch stamped at the review cutoff keeps reuse-analyzer listed', () => {
    assert.match(classifyTranscript({ main: bigThenDispatch('reuse-analyzer'), input: { review_cutoff: stamp(2) } }), allEight);
  });

  const linkedRun = (member) => [
    dispatchOf(member, { id: 'run', at: stamp(2) }),
    resultOf('run', { at: stamp(3), content: [{ type: 'text', text: 'done\nagentId: r1 (use SendMessage to continue)' }] }),
  ];
  const attachment = (body) => ({ type: 'attachment', attachment: body });
  const reviewer = (shown, { brief = 'review the change', blob = brief, instructions = 'house rules', gitStatus = 'clean', after = [] } = {}) => ({
    'agent-r1.jsonl': () => [
      { type: 'user', message: { role: 'user', content: brief } },
      { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>\nYour final report goes through the handback tool.\n</system-reminder>' } },
      attachment({ type: 'instructions', files: [{ path: '/home/CLAUDE.md', type: 'User', content: instructions }] }),
      attachment({ type: 'session_context', context: { gitStatus } }),
      { type: 'api-request-blob', hash: 'h1', message: { role: 'user', content: [{ type: 'text', text: blob }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `opened ${shown.join(' ')}` }] } },
      ...after,
    ],
  });
  const writesThenRun = (files, member) => (repo) => [
    ...Object.entries(files).map(([name, content]) => writeOf(path.join(repo, name), content, { at: stamp(1) })),
    ...(member ? linkedRun(member) : []),
  ];
  const owedFor = (out, member) => (out.match(/ owed-files=([^\s>]*)>/)?.[1] ?? '').split(';').find((entry) => entry.startsWith(`${member}:`))?.slice(member.length + 1);
  const twoFiles = { 'a.ts': sourceLines(200), 'b.ts': sourceLines(200) };
  const reuseRun = ({ files = twoFiles, onDisk = files, shown = ['a.ts'], ...rest } = {}) => classifyTranscript({ onDisk, main: writesThenRun(files, 'reuse-analyzer'), agents: reviewer(shown), ...rest });

  const eightWithout = (member) => required(['code-reviewer', ...bigSeven.filter((m) => m !== member)]);
  const afterBig = (...records) => (repo) => [writeOf(path.join(repo, 'impl.ts'), sourceLines(200), { at: stamp(1) }), ...records];
  const skillCall = (skill, { id = 'skill', at = 2 } = {}) => toolCall('Skill', { skill }, { id, at: stamp(at) });

  await t.test('skill members: a main-thread Skill delete-list call after 200 lines drops delete-list from required and owed-files', () => {
    const before = classifyTranscript({ main: afterBig() });
    assert.match(before, allEight);
    assert.equal(owedFor(before, 'delete-list'), 'impl.ts');
    const out = classifyTranscript({ main: afterBig(skillCall('delete-list')) });
    assert.match(out, eightWithout('delete-list'));
    assert.equal(owedFor(out, 'delete-list'), undefined);
    assert.equal(owedFor(out, 'security-review'), 'impl.ts');
    assert.match(classifyTranscript({ main: afterBig(skillCall('plugin:security-review')) }), eightWithout('security-review'));
  });

  const skillTwins = [
    ['an Agent dispatch named delete-list', afterBig(dispatchOf('delete-list', { id: 'skill', at: stamp(2) })), {}],
    ['a Skill call before the writes', (repo) => [skillCall('delete-list', { at: 0 }), ...afterBig()(repo)], {}],
    ['a Skill call with an errored result', afterBig(skillCall('delete-list'), resultOf('skill', { error: true, at: stamp(2) })), {}],
    ['a Skill call named for an agent member', afterBig(skillCall('reuse-analyzer')), {}],
  ];
  for (const [name, main, input] of skillTwins) {
    await t.test(`skill members twin: ${name} leaves all eight listed and delete-list owed`, () => {
      const out = classifyTranscript({ main, input });
      assert.match(out, allEight);
      assert.equal(owedFor(out, 'delete-list'), 'impl.ts');
    });
  }

  await t.test('skill members twin: a Skill call stamped at the review cutoff keeps delete-list listed', () => {
    assert.match(classifyTranscript({ main: afterBig(skillCall('delete-list')), input: { review_cutoff: stamp(2) } }), allEight);
  });

  await t.test('skill members twin: an Agent dispatch named security-review and a Skill call inside a subagent clear nothing', () => {
    const agentNamed = classifyTranscript({ main: afterBig(dispatchOf('security-review', { id: 'skill', at: stamp(2) })) });
    assert.match(agentNamed, allEight);
    assert.equal(owedFor(agentNamed, 'security-review'), 'impl.ts');
    const inSubagent = classifyTranscript({ main: afterBig(), agents: { 'agent-s1.jsonl': () => [skillCall('delete-list')] } });
    assert.match(inSubagent, allEight);
    assert.equal(owedFor(inSubagent, 'delete-list'), 'impl.ts');
  });

  await t.test('shown: a linked run that was shown a.ts only leaves reuse-analyzer listed with b.ts owed', () => {
    const out = reuseRun();
    assert.match(out, allEight);
    assert.equal(owedFor(out, 'reuse-analyzer'), 'b.ts');
  });

  const owesB = (out) => {
    assert.match(out, allEight);
    assert.equal(owedFor(out, 'reuse-analyzer'), 'b.ts');
  };

  await t.test('shown: a path named only in the reviewer brief does not clear its file', () => {
    owesB(reuseRun({ agents: reviewer(['a.ts'], { brief: 'review a.ts and b.ts' }) }));
  });

  await t.test('shown: a brief repeated in an api-request-blob record does not clear its file', () => {
    owesB(reuseRun({ agents: reviewer(['a.ts'], { blob: 'review a.ts and b.ts' }) }));
  });

  await t.test('shown: an instructions attachment naming the path does not clear its file', () => {
    owesB(reuseRun({ agents: reviewer(['a.ts'], { instructions: 'rules for b.ts' }) }));
  });

  await t.test('shown: a session_context gitStatus naming the path does not clear its file', () => {
    owesB(reuseRun({ agents: reviewer(['a.ts'], { gitStatus: 'M b.ts' }) }));
  });

  await t.test('quiet: a path in a tool_result clears its file', () => {
    const agents = reviewer(['a.ts'], { after: [resultOf('t1', { content: [{ type: 'text', text: 'src listing: b.ts' }] })] });
    assert.match(reuseRun({ agents }), allEightWithout('reuse-analyzer'));
  });

  await t.test('quiet: a run shown both paths drops reuse-analyzer', () => {
    assert.match(reuseRun({ shown: ['a.ts', 'b.ts'] }), allEightWithout('reuse-analyzer'));
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

  const worktreeFiles = { '.claude/worktrees/wt/a.ts': sourceLines(200), '.claude/worktrees/wt/b.ts': sourceLines(200) };

  await t.test('quiet: files written in a worktree clear when the run names them by their path inside it', () => {
    assert.match(reuseRun({ files: worktreeFiles, shown: ['a.ts', 'b.ts'] }), allEightWithout('reuse-analyzer'));
  });

  await t.test('shown: a worktree file the run never names stays owed under its worktree path', () => {
    const out = reuseRun({ files: worktreeFiles, shown: ['a.ts'] });
    assert.match(out, allEight);
    assert.equal(owedFor(out, 'reuse-analyzer'), '.claude/worktrees/wt/b.ts');
  });

  await t.test('shown: before the review cutoff reuse-analyzer lists both files, owed-files keeps b.ts only', () => {
    const out = reuseRun({ input: { review_cutoff: stamp(2) } });
    assert.match(out, allEight);
    assert.equal(owedFor(out, 'reuse-analyzer'), 'b.ts');
  });

  await t.test('shown: a run before the review cutoff shown a.ts only keeps reuse-analyzer listed and owes b.ts', () => {
    const out = reuseRun({ input: { review_cutoff: stamp(5) } });
    assert.match(out, allEight);
    assert.equal(owedFor(out, 'reuse-analyzer'), 'b.ts');
  });

  await t.test('quiet: before the review cutoff, a run shown both paths lists reuse-analyzer with no entry for it', () => {
    const out = reuseRun({ shown: ['a.ts', 'b.ts'], input: { review_cutoff: stamp(2) } });
    assert.match(out, allEight);
    assert.equal(owedFor(out, 'reuse-analyzer'), undefined);
  });

  await t.test('quiet: a file no longer on disk is cleared by the later run', () => {
    assert.match(reuseRun({ onDisk: { 'a.ts': twoFiles['a.ts'] } }), allEightWithout('reuse-analyzer'));
  });

  await t.test('quiet: a run whose result holds no agentId clears both files', () => {
    const main = (repo) => [...writesThenRun(twoFiles)(repo), dispatchOf('reuse-analyzer', { id: 'run', at: stamp(2) }), resultOf('run', { at: stamp(3) })];
    assert.match(classifyTranscript({ onDisk: twoFiles, main }), allEightWithout('reuse-analyzer'));
  });

  await t.test('quiet: a linked id with no agent-r1.jsonl clears both files', () => {
    assert.match(classifyTranscript({ onDisk: twoFiles, main: writesThenRun(twoFiles, 'reuse-analyzer') }), allEightWithout('reuse-analyzer'));
  });

  await t.test('quiet: a linked id whose agent-r1.jsonl cannot be read clears both files', () => {
    assert.match(classifyTranscript({ onDisk: twoFiles, main: writesThenRun(twoFiles, 'reuse-analyzer'), unreadable: ['agent-r1.jsonl'] }), allEightWithout('reuse-analyzer'));
  });

  await t.test('quiet: 30 lines left unshown are under 200, so reuse-analyzer is dropped', () => {
    assert.match(reuseRun({ files: { 'a.ts': sourceLines(250), 'b.ts': sourceLines(30) } }), allEightWithout('reuse-analyzer'));
  });

  await t.test('owed-files: seven owed files print the five largest, largest first, then +2', () => {
    const lineCounts = { 'f1.ts': 30, 'f2.ts': 40, 'f3.ts': 35, 'f4.ts': 50, 'f5.ts': 45, 'f6.ts': 32, 'f7.ts': 60 };
    const files = Object.fromEntries(Object.entries(lineCounts).map(([name, count]) => [name, sourceLines(count)]));
    const out = classifyTranscript({ onDisk: files, main: writesThenRun(files) });
    assert.equal(owedFor(out, 'reuse-analyzer'), 'f7.ts,f4.ts,f5.ts,f2.ts,f3.ts,+2');
  });

  await t.test('owed-files: a path with a space is percent-encoded', () => {
    const files = { 'my file.ts': sourceLines(200) };
    assert.equal(owedFor(classifyTranscript({ onDisk: files, main: writesThenRun(files) }), 'reuse-analyzer'), 'my%20file.ts');
  });

  await t.test('owed-files: a path holding the list delimiters and % is percent-encoded', () => {
    const files = { 'a,b;c:d+e%f.ts': sourceLines(200) };
    assert.equal(owedFor(classifyTranscript({ onDisk: files, main: writesThenRun(files) }), 'reuse-analyzer'), 'a%2Cb%3Bc%3Ad%2Be%25f.ts');
  });

  await t.test('owed-files: a silent-failure-hunter run shown a.ts only leaves b.ts owed', () => {
    const files = { 'a.ts': sourceLines(200, withCatch), 'b.ts': sourceLines(200) };
    const out = classifyTranscript({ onDisk: files, main: writesThenRun(files, 'silent-failure-hunter'), agents: reviewer(['a.ts']) });
    assert.equal(owedFor(out, 'silent-failure-hunter'), 'b.ts');
  });

  await t.test('guard: a catch file shown to silent-failure-hunter stays required by signal with no owed entry', () => {
    const files = { 'a.ts': sourceLines(200, withCatch) };
    const out = classifyTranscript({ onDisk: files, main: writesThenRun(files, 'silent-failure-hunter'), agents: reviewer(['a.ts']) });
    assert.match(out, allEight);
    assert.equal(owedFor(out, 'silent-failure-hunter'), undefined);
  });

  await t.test('guard: with no Big member owed the joins line holds no owed-files', () => {
    const files = { 'a.ts': sourceLines(200) };
    const main = (repo) => [
      ...writesThenRun(files)(repo),
      ...bigSeven.flatMap((member, i) => [runOf(member, { id: `big${i}`, at: stamp(2) }), resultOf(`big${i}`, { at: stamp(3) })]),
    ];
    const out = classifyTranscript({ onDisk: files, main });
    assert.match(out, / required=code-reviewer /);
    assert.doesNotMatch(out, /owed-files=/);
  });

  await t.test('guard: a comment-only change of 200 lines prints required=none and no owed-files', () => {
    const comments = Array.from({ length: 200 }, (_, i) => `// note ${i}`).join('\n') + '\n';
    const out = classifyTranscript({ commit: { 'a.ts': 'export const a = 1;\n' }, onDisk: { 'a.ts': `export const a = 1;\n${comments}` }, main: written('a.ts', comments) });
    assert.match(out, / required=none /);
    assert.doesNotMatch(out, /owed-files=/);
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
