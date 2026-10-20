'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'plan-lint.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-lint-'));
const homePlan = path.join(os.homedir(), '.claude', 'plans', `plan-lint-test-${process.pid}.md`);

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(homePlan, { force: true });
});

function planFile(root, name = 'x.md', content) {
  const file = path.join(root, 'docs', 'plans', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

function run(mode, toolInput) {
  const res = spawnSync('node', [HOOK_PATH, mode], { input: JSON.stringify({ tool_input: toolInput }), encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const writeContent = (file, content) => run('pre', { file_path: file, content });
const reasonOf = (res) => JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason;

function check(content) {
  const file = path.join(tmpDir, `check-${checkCount++}.md`);
  fs.writeFileSync(file, content);
  const res = spawnSync('node', [HOOK_PATH, 'check', file], { encoding: 'utf8' });
  const lines = res.stderr.split('\n').filter((line) => line.startsWith(`${file}:`));
  return { code: res.status, stderr: res.stderr, findings: lines.map((line) => line.slice(file.length + 1)) };
}

let checkCount = 0;
const rulesOf = (content) => check(content).findings.map((finding) => finding.split(' ')[1]);

const STEPS_PREAMBLE_LINES = [
  'Each step ends with lint, `pnpm typecheck`, its `→ verify:`, a diff review and one local commit.',
  'A step that renders a key adds it to the CSVs (en and zh, the Copy table) and runs',
  '`pnpm translations:keys` in the same commit. Steps 1–5 are independent; 6–10 need them.',
];

test('plan lint', async (t) => {
  const plain = planFile(path.join(tmpDir, 'plain'));

  await t.test('denies a journal word in prose', () => {
    const res = writeContent(plain, '# Plan\n\nWe found the bug in the loader.\n');
    assert.equal(res.code, 0);
    const decision = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal(decision.hookEventName, 'PreToolUse');
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /3 P1 We found the bug in the loader\./);
    assert.match(decision.permissionDecisionReason, /rephrase as an instruction, a decision or a sourced fact row/);
  });

  await t.test('denies an Edit new_string the same way', () => {
    const res = run('pre', { file_path: plain, old_string: 'a', new_string: 'It turned out to be slow.' });
    assert.match(reasonOf(res), /1 P1 It turned out to be slow\./);
  });

  await t.test('denies a capital I but not the i.e. abbreviation', () => {
    assert.match(reasonOf(writeContent(plain, 'I checked it.')), /P1/);
    assert.equal(writeContent(plain, 'Use a fixed width, i.e. 12px.').stdout, '');
  });

  await t.test('allows the same word in backticks', () => {
    const res = writeContent(plain, 'Never write `we found` in a plan.\n');
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
  });

  await t.test('allows the word inside a code fence and inside quotes', () => {
    assert.equal(writeContent(plain, 'Steps:\n\n```\nwe found it\n```\n').stdout, '');
    assert.equal(writeContent(plain, 'The banner reads "we found nothing".\n').stdout, '');
  });

  await t.test('allows a sourced fact row', () => {
    const res = writeContent(plain, 'Sampled on ocbc-dev\n');
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
  });

  await t.test('allows a path outside the plan directories', () => {
    const res = writeContent(path.join(tmpDir, 'notes.md'), 'We found it.\n');
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
  });

  await t.test('post exits 2 with findings on stderr for a file on disk', () => {
    const file = planFile(path.join(tmpDir, 'post'), 'x.md', '# Plan\n\nwe found it\n');
    const res = run('post', { file_path: file });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /3 P1 we found it/);
  });

  await t.test('post passes a clean file', () => {
    const file = planFile(path.join(tmpDir, 'post-clean'), 'x.md', '# Plan\n\nRun the check.\n');
    const res = run('post', { file_path: file });
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');
  });

  await t.test('handles a plan under ~/.claude/plans', () => {
    fs.writeFileSync(homePlan, 'we found it\n');
    assert.equal(JSON.parse(run('pre', { file_path: homePlan, content: 'we found it\n' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(run('post', { file_path: homePlan }).code, 2);
    assert.equal(writeContent(homePlan, 'Run the check.\n').stdout, '');
  });

  await t.test('lints any path with a plans directory segment', () => {
    const inPlans = path.join(tmpDir, 'plans', 'x.md');
    const inNotPlans = path.join(tmpDir, 'notplans', 'x.md');
    assert.match(reasonOf(writeContent(inPlans, 'we found it\n')), /1 P1 we found it/);
    assert.equal(writeContent(inNotPlans, 'we found it\n').stdout, '');
  });

  await t.test('skips a research file beside the plans', () => {
    const research = path.join(tmpDir, 'plans', 'x.research.md');
    fs.mkdirSync(path.dirname(research), { recursive: true });
    fs.writeFileSync(research, 'we found it\n');
    assert.equal(writeContent(research, 'we found it\n').stdout, '');
    assert.equal(run('post', { file_path: research }).code, 0);
  });

  await t.test('pre applies P1 only and ignores a 300-char paragraph', () => {
    assert.equal(writeContent(plain, `${'x '.repeat(150).trim()}\n`).stdout, '');
  });

  await t.test('post applies P2 to a long paragraph on disk', () => {
    const file = planFile(path.join(tmpDir, 'post-long'), 'x.md', `${'x '.repeat(150).trim()}\n`);
    const res = run('post', { file_path: file });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /1 P2 x x/);
  });

  await t.test('fails open on malformed input', () => {
    const res = spawnSync('node', [HOOK_PATH, 'pre'], { input: 'not json', encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });
});

test('check P1', async (t) => {
  await t.test('fails a journal marker and a first-person I, one finding per line', () => {
    const res = check('Turned out the API is flat.\nI checked it.\n');
    assert.equal(res.code, 1);
    assert.deepEqual(res.findings, ['1 P1 Turned out the API is flat.', '2 P1 I checked it.']);
    assert.equal(
      res.stderr.trimEnd().split('\n').at(-1),
      'rephrase as an instruction, a decision or a sourced fact row; move sampled, traced or dated material to <name>.research.md',
    );
  });

  await t.test('passes markers inside backticks, quotes, fences and a Source column', () => {
    const res = check(
      [
        'Use `we found` as a token, and "we found" or “we found” as text.',
        '',
        '```',
        'we found it, I think',
        '```',
        '',
        '| Field | Source |',
        '| ----- | ------ |',
        '| id    | we found it in the sample |',
        '',
      ].join('\n'),
    );
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');
  });

  await t.test('still scans the other columns of a table with a Source column', () => {
    assert.deepEqual(rulesOf(['| Field | Source |', '| --- | --- |', '| we found | sample |'].join('\n')), ['P1']);
  });

  await t.test('passes "Sampled on ocbc-dev" and "i.e."', () => {
    assert.equal(check('Sampled on ocbc-dev, i.e. the shared contact.\n').code, 0);
  });
});

test('check P2', async (t) => {
  await t.test('fails a paragraph over 200 characters and passes 200 or fewer', () => {
    assert.deepEqual(rulesOf('x '.repeat(101).trim()), ['P2']);
    assert.deepEqual(rulesOf('x '.repeat(100).trim()), []);
  });

  await t.test('fails the Steps preamble as three wrapped lines and as one line', () => {
    assert.deepEqual(check(`## Steps\n\n${STEPS_PREAMBLE_LINES.join('\n')}`).findings, [`3 P2 ${STEPS_PREAMBLE_LINES[0]}`]);
    assert.deepEqual(rulesOf(`## Steps\n\n${STEPS_PREAMBLE_LINES.join(' ')}`), ['P2']);
  });

  await t.test('allows 500 characters inside Context and not after it', () => {
    const paragraph = 'x '.repeat(200).trim();
    assert.deepEqual(rulesOf(`## Context\n\n${paragraph}`), []);
    assert.deepEqual(rulesOf(`## Context\n\n${paragraph}\n\n## Rules\n\n${paragraph}`), ['P2']);
    assert.deepEqual(rulesOf(`## Context\n\n${'x '.repeat(260).trim()}`), ['P2']);
  });

  await t.test('does not count headings, list items, continuations, table rows or verify lines', () => {
    const long = 'x '.repeat(150).trim();
    assert.deepEqual(rulesOf([`# ${long}`, `- ${long}`, `  ${long}`, `| ${long} |`, `→ verify: ${long}`].join('\n')), []);
  });
});

test('check P3', async (t) => {
  await t.test('fails a step with no verify line', () => {
    assert.deepEqual(check('## Steps\n\n### 2. Foo\n\n- do it\n').findings, ['3 P3 ### 2. Foo']);
  });

  await t.test('fails a bold list step whose verify belongs to the next step', () => {
    const text = ['1. **One.**', '', '2. **Two.**', '', '    → verify: run it'].join('\n');
    assert.deepEqual(check(text).findings, ['1 P3 1. **One.**']);
  });

  await t.test('passes a step with a verify line before the next step, heading or end', () => {
    const text = ['### 1. Foo', '', '→ verify: `pnpm test`', '', '### 2. Bar', '', '→ verify: `pnpm lint`', '', '## Gate'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('passes a step whose verify a formatter wrapped after the arrow', () => {
    const text = ['## Steps', '', '1. Wire it up. Serves A1. →', '   verify: `npx tsc --noEmit` clean.'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('fails a step with a dangling arrow and no verify', () => {
    const text = ['## Steps', '', '1. Wire it up. Serves A1. →', '   then lint it.'].join('\n');
    assert.deepEqual(check(text).findings, ['3 P3 1. Wire it up. Serves A1. →']);
  });

  await t.test('fails a plain numbered step under Steps that has no verify line', () => {
    const text = ['## Steps', '', '1. Create the file. → verify: `ls`', '2. Wire it up.'].join('\n');
    assert.deepEqual(check(text).findings, ['4 P3 2. Wire it up.']);
  });

  await t.test('passes plain numbered steps under Steps that each carry a verify line', () => {
    const text = ['## Steps', '', '1. Create the file.', '   → verify: `ls`', '', '2. Wire it up.', '   → verify: `pnpm test`'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('ignores a plain numbered list outside Steps', () => {
    assert.deepEqual(rulesOf(['## Verification', '', '1. Run the check.', '2. Read the output.'].join('\n')), []);
  });

  await t.test('keeps a nested plain list inside a ### step from becoming a step', () => {
    const text = ['## Steps', '', '### 1. Foo', '', '1. first', '2. second', '', '→ verify: `pnpm test`'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });
});

test('check P4', async (t) => {
  await t.test('fails an Open bullet spanning four lines', () => {
    const text = ['## Open', '', '- first line', '  second', '  third', '  fourth'].join('\n');
    assert.deepEqual(check(text).findings, ['3 P4 - first line']);
  });

  await t.test('passes Open bullets of up to three lines, and long bullets elsewhere', () => {
    const text = ['## Open', '', '- one', '  two', '  three', '- short', '', '## Rules', '', '- one', '  two', '  three', '  four'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('ends a bullet at a blank line followed by a non-indented line', () => {
    assert.deepEqual(rulesOf(['## Open', '', '- one', '  two', '', 'a', 'b', 'c', 'd'].join('\n')), []);
  });
});

test('check P5', async (t) => {
  await t.test('fails a section heading naming a trace, a sample or a date', () => {
    assert.deepEqual(check('## Repo vs demo (traced)\n').findings, ['1 P5 ## Repo vs demo (traced)']);
    assert.deepEqual(check('## Demo journey (sampled 2026-10-13)\n').findings, ['1 P5 ## Demo journey (sampled 2026-10-13)']);
  });

  await t.test('passes ordinary headings, a path in backticks and a ### heading', () => {
    const text = ['## Patterns to mirror', '', '## Facts the plan rests on', '', '## Files in `logs/`', '', '### Log out step'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('pre ignores a research heading', () => {
    assert.equal(writeContent(path.join(tmpDir, 'plans', 'x.md'), '## Repo vs demo\n').stdout, '');
  });
});

test('check P6', async (t) => {
  await t.test('fails a dated status line, a dated prose line and a dated ### heading', () => {
    assert.deepEqual(check('- Status 2026-10-13: built and verified.\n').findings, ['1 P6 - Status 2026-10-13: built and verified.']);
    assert.deepEqual(rulesOf('Decided with the user (Praveen, 2026-09-19).\n'), ['P6']);
    assert.deepEqual(rulesOf('### Revised 2026-09-19\n'), ['P6']);
  });

  await t.test('passes a date in backticks, quotes, a fence and a Source column', () => {
    assert.deepEqual(rulesOf('Path `out/2026-10-04/x.json`.\n'), []);
    assert.deepEqual(rulesOf('Wording "confirmed 2026-10-08".\n'), []);
    assert.deepEqual(rulesOf('Steps:\n\n```\nrun of 2026-10-13\n```\n'), []);
    assert.deepEqual(rulesOf(['| Fact | Source |', '|---|---|', '| flat API | sample 2026-10-13 |'].join('\n')), []);
  });

  await t.test('passes version and node strings', () => {
    assert.deepEqual(rulesOf('Pin v8.0.6 and read node 1156:37436.\n'), []);
  });

  await t.test('gives a dated ## heading P5 only', () => {
    assert.deepEqual(rulesOf('## Addendum 2026-09-20\n'), ['P5']);
  });

  await t.test('pre ignores a date', () => {
    assert.equal(writeContent(path.join(tmpDir, 'plans', 'x.md'), '- Status 2026-10-13\n').stdout, '');
  });
});

test('check P7', async (t) => {
  const P7_HINT = 'name each criterion in the step that delivers it';
  const REPHRASE_HINT =
    'rephrase as an instruction, a decision or a sourced fact row; move sampled, traced or dated material to <name>.research.md';
  const A2_UNNAMED = ['## Criteria', '', '- A1: first', '- A2: second', '', '## Step 1: hook (A1)'];

  await t.test('fails a criterion that no step names, at the criterion line', () => {
    assert.deepEqual(check(A2_UNNAMED.join('\n')).findings, ['4 P7 criterion A2 has no step']);
  });

  await t.test('does not read A10 as naming A1', () => {
    const text = ['## Criteria', '', '- A1: first', '- A10: tenth', '', '## Step 1: hook (A10)'].join('\n');
    assert.deepEqual(check(text).findings, ['3 P7 criterion A1 has no step']);
  });

  await t.test('does not count a name under Decided, Open or inside a fence', () => {
    const decided = [...A2_UNNAMED, '', '## Decided', '', '- A2 is settled'];
    const open = [...A2_UNNAMED, '', '## Open', '', '- A2 is undecided'];
    const fenced = [...A2_UNNAMED, '', '```', 'A2', '```'];
    assert.deepEqual(check(decided.join('\n')).findings, ['4 P7 criterion A2 has no step']);
    assert.deepEqual(check(open.join('\n')).findings, ['4 P7 criterion A2 has no step']);
    assert.deepEqual(check(fenced.join('\n')).findings, ['4 P7 criterion A2 has no step']);
  });

  await t.test('passes a range, in all three forms, and an S<n> heading', () => {
    const criteria = ['## Criteria', '', '- A1: first', '- A2: second', '- A3: third', '- A4: fourth', ''];
    assert.deepEqual(rulesOf([...criteria, '## Step 1: hook (A1–A4)'].join('\n')), []);
    assert.deepEqual(rulesOf([...criteria, '## Step 1: hook (A1-A4)'].join('\n')), []);
    assert.deepEqual(rulesOf([...criteria, '## Step 1: hook (A1-4)'].join('\n')), []);
    assert.deepEqual(rulesOf([...criteria, '## S1 — hook (A1–A2)', '', '## S2 — rules (A3-A4)'].join('\n')), []);
  });

  await t.test('names a criterion from the body of a step section', () => {
    const text = ['## Criteria', '', '- A1: first', '', '## Steps', '', '- Wire it up (A1).'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('passes bold and backticked criterion bullets', () => {
    const text = ['## Criteria', '', '- **A1**: first', '- `A2`: second', '', '## Step 1: hook (A1, A2)'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('reads an Acceptance and an acceptance criteria heading', () => {
    assert.deepEqual(check(A2_UNNAMED.join('\n').replace('## Criteria', '## Acceptance')).findings, ['4 P7 criterion A2 has no step']);
    assert.deepEqual(check(A2_UNNAMED.join('\n').replace('## Criteria', '## acceptance criteria')).findings, [
      '4 P7 criterion A2 has no step',
    ]);
  });

  await t.test('passes criteria with no step section, and an empty file', () => {
    assert.deepEqual(rulesOf(['## Criteria', '', '- A1: first'].join('\n')), []);
    assert.deepEqual(rulesOf(''), []);
  });

  await t.test('does not read a bullet inside a fence under Criteria as a criterion', () => {
    const text = ['## Criteria', '', '- A1: first', '', '```', '- A3: third', '```', '', '## Step 1: hook (A1)'].join('\n');
    assert.deepEqual(rulesOf(text), []);
  });

  await t.test('ends with the P7 hint alone, and with the rephrase hint when another rule fires', () => {
    const alone = check(A2_UNNAMED.join('\n'));
    assert.equal(alone.code, 1);
    assert.equal(alone.stderr.trimEnd().split('\n').at(-1), P7_HINT);
    assert.doesNotMatch(alone.stderr, /rephrase/);

    const withP1 = check(['I checked it.', ...A2_UNNAMED].join('\n'));
    assert.deepEqual(withP1.findings, ['1 P1 I checked it.', '5 P7 criterion A2 has no step']);
    assert.deepEqual(withP1.stderr.trimEnd().split('\n').slice(-2), [P7_HINT, REPHRASE_HINT]);
  });

  await t.test('post exits 2 with the P7 line for a plan on disk', () => {
    const file = planFile(path.join(tmpDir, 'post-p7'), 'x.md', A2_UNNAMED.join('\n'));
    const res = run('post', { file_path: file });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /4 P7 criterion A2 has no step/);
  });
});

test('check CLI', async (t) => {
  await t.test('exits 0 silently on a clean file', () => {
    const res = check('Add the key.\n');
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');
  });

  await t.test('exits 1 and names a missing file', () => {
    const missing = path.join(tmpDir, 'missing.md');
    const res = spawnSync('node', [HOOK_PATH, 'check', missing], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: unreadable`));
  });
});
