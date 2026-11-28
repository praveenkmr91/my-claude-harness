'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  stamp, sourceLines, withCatch, toolCall, writeOf, resultOf, classifyTranscript,
  written, plainRun, linkedRun, attachment, reviewer, required, owedFor, four, bigFive, bigFiveWithout,
} = require('./helpers/review-classify');

test('review-classify owed files and background runs', async (t) => {
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

  const declared = 'export function build() { return 1; }';
  const threeComments = '// first\n// second\n// third';
  const ownedBy = (first, count = 30, input) => classifyTranscript({ main: written('impl.ts', sourceLines(count, first)), ...(input && { input }) });
  const declaredThenRun = (member) => {
    const files = { 'a.ts': sourceLines(30, declared) };
    return classifyTranscript({ onDisk: files, main: writesThenRun(files, member), agents: reviewer(['a.ts']) });
  };

  await t.test('signal members: 30 lines holding a function declaration list code-reviewer and reuse-analyzer', () => {
    assert.match(ownedBy(declared), / required=code-reviewer,reuse-analyzer /);
    assert.match(ownedBy('export const build = async (input: string): Promise<number> => 1;'), / required=code-reviewer,reuse-analyzer /);
  });

  await t.test('signal members: an arrow function whose parameter list a formatter wrapped, or that takes a type parameter, lists reuse-analyzer', () => {
    for (const first of ['export const Card = ({\n  title,\n}: CardProps) => {', 'export const submit = async (\n  values: FormValues,\n): Promise<void> => {', 'export const identity = <T,>(value: T): T => value;', 'export const submit = (\n  values: FormValues,\n): number => {', 'export const pick = (\n  a: number,\n) => a;', 'export const keyed = <T extends Record<string, unknown>>(value: T) => value;', 'export const withDefault = (a = getDefault()) => a;', 'export default function () { return 1; }', 'export function* each() { yield 1; }', 'export const legacy = function () { return 1; };']) {
      assert.match(ownedBy(first), / required=code-reviewer,reuse-analyzer /, first);
    }
  });

  await t.test('signal members twin: 30 plain lines, or a wrapped expression opening `= (`, list code-reviewer alone', () => {
    assert.match(ownedBy(undefined), / required=code-reviewer /);
    assert.match(ownedBy('export const total = (\n  1 + 2\n);'), / required=code-reviewer /);
    assert.match(ownedBy('export const doubled = list.map((x) => x * 2);'), / required=code-reviewer /);
  });

  await t.test('signal members: 30 lines holding three comment lines list code-reviewer and comment-analyzer', () => {
    assert.match(ownedBy(threeComments), / required=code-reviewer,comment-analyzer /);
  });

  await t.test('signal members twin: two comment lines list code-reviewer alone', () => {
    assert.match(ownedBy('// first\n// second'), / required=code-reviewer /);
  });

  await t.test('signal members: a code-reviewer run shown the file leaves reuse-analyzer listed alone', () => {
    assert.match(declaredThenRun('code-reviewer'), / required=reuse-analyzer /);
  });

  await t.test('signal members twin: a reuse-analyzer run shown the file drops it and code-reviewer stays listed', () => {
    assert.match(declaredThenRun('reuse-analyzer'), / required=code-reviewer /);
  });

  await t.test('signal members guard: 15 lines holding a function declaration list nothing', () => {
    assert.match(ownedBy(declared, 15), / required=none /);
  });

  await t.test('signal members guard: 250 plain lines list code-reviewer and the Big members, neither signal member', () => {
    assert.match(ownedBy(undefined, 250), bigFive);
  });

  await t.test('signal members guard: report scope, the 30 lines with the declaration list nothing', () => {
    assert.match(ownedBy(declared, 30, scoped), / required=none /);
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
