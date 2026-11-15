'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  HOOK_PATH, tmpDir, BASE_VERDICTS, LENS_SKIPS, LEARN_SKIP, RAW_OUTPUT, LENS_AGENTS,
  handBack, handBackAttachment, repoWith, nextSeq, run, runFull, runWithResults,
} = require('./helpers/done-claim-gate');

test('done-claim gate: plan build', async (t) => {
  await t.test('a `Pass: <verb>` line in the reply needs real member calls, even on a no-edit turn', () => {
    const agent = (subagent_type) => ({ type: 'tool_use', name: 'Agent', input: { subagent_type } });
    const skill = (name) => ({ type: 'tool_use', name: 'Skill', input: { skill: name } });
    const { status, stderr } = runFull('Pass: harden\nadversarial-reviewer: 0 findings\nsecurity-review: 0 findings', { editedFile: null });
    assert.equal(status, 2);
    assert.match(stderr, /NAMED VERB NOT RUN[\s\S]*`Pass: harden`[\s\S]*adversarial-reviewer, security-review/);
    assert.equal(run('Pass: harden\nTwo findings below.', { editedFile: null, reviews: [skill('adversarial-reviewer'), skill('security-review')] }), 0);
    assert.equal(run('Pass: harden\nTwo findings below.', { editedFile: null, reviews: [agent('adversarial-reviewer'), skill('security-review')] }), 0);
    const battery = ['code-reviewer', 'silent-failure-hunter', 'type-design-analyzer', 'reuse-analyzer', 'placement-analyzer', 'comment-analyzer', 'modern-ts-analyzer'];
    assert.equal(run('Pass: battery\nFindings below.', { editedFile: null, reviews: battery.slice(1).map(agent) }), 2);
    assert.equal(run('Pass: battery\nFindings below.', { editedFile: null, reviews: battery.map((m) => agent(`pr-review-toolkit:${m}`)) }), 0);
  });

  await t.test('a bullet, bold or backtick `Pass:` label counts as the announcement', () => {
    assert.equal(run('- **Pass:** trim\nFindings below.', { editedFile: null }), 2);
    assert.equal(run('`Pass:` trim\nFindings below.', { editedFile: null }), 2);
    assert.equal(run('pass: trim\nFindings below.', { editedFile: null }), 2);
  });

  await t.test('a named-verb member declared `not run — <reason>` counts as handled; undeclared members stay missing', () => {
    const opts = { editedFile: null };
    assert.equal(run('Pass: harden\nsecurity-review: not run — ran last turn on the same diff\nadversarial-reviewer: not run — same', opts), 0);
    const { status, stderr } = runFull('Pass: harden\nsecurity-review: not run — ran last turn on the same diff', opts);
    assert.equal(status, 2);
    assert.match(stderr, /no Skill\/Agent call ran for adversarial-reviewer\./);
    assert.match(stderr, /`<member>: not run — <reason>`/);
  });

  await t.test('talking about a verb is not announcing it: the prompt is never read, and `Pass:` must start a line', () => {
    assert.equal(run('Findings below.', { editedFile: null, prompt: 'run the battery' }), 0);
    assert.equal(run('The battery now accepts a model.', { editedFile: null, prompt: 'i want battery review to also accept model' }), 0);
    assert.equal(run('See Pass: battery in the routing doc.', { editedFile: null }), 0);
    assert.equal(run('', { editedFile: null }), 0);
  });

  await t.test('isMeta records (skill bodies, hand-backs, hook feedback) do not reset the turn', () => {
    const skill = (name) => ({ type: 'tool_use', name: 'Skill', input: { skill: name } });
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'harden the auth hook' } },
      { type: 'assistant', message: { content: [skill('adversarial-reviewer'), skill('security-review')] } },
      { type: 'user', isMeta: true, message: { content: 'You are a senior security engineer doing a security review' } },
      { type: 'user', isMeta: true, message: { content: 'Stop hook feedback: this reply announces `Pass: trim`' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Pass: harden\nTwo findings below.' }] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const { status } = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    assert.equal(status, 0);
  });

  await t.test('an implementer nudge needs a dispatch or verdict line in the same turn', () => {
    const runNudged = (reply) => {
      const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
      fs.writeFileSync(transcriptPath, [
        { type: 'user', message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'This Opus thread is about to write source (/repo/src/app.ts) with no `implementer` dispatch this turn.' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
      ].map((e) => JSON.stringify(e)).join('\n'));
      return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    };
    const silent = runNudged('Notes updated.');
    assert.equal(silent.status, 2);
    assert.match(silent.stderr, /IMPLEMENTER NUDGE UNANSWERED/);
    assert.equal(runNudged('implementer: skip — design edits, nearly done.\nNotes updated.').status, 0);
    for (const line of [
      "- **implementer:** skipped. The remaining edits are a few small, interlinked harness changes.",
      "implementer: skipped. This is a single small hook that I'm testing directly.",
      '**implementer**: skip — reason',
      '`implementer`: dispatching',
    ]) {
      assert.equal(runNudged(`${line}\nNotes updated.`).status, 0, line);
    }
    for (const line of ['implementer: skipped', 'implementer: skip —', 'implementer:']) {
      assert.equal(runNudged(`${line}\nNotes updated.`).status, 2, line);
    }
  });

  await t.test('a write-block arrives as an errored tool_result and no implementer verdict follows', () => {
    const runNudged = (reply) => {
      const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
      fs.writeFileSync(transcriptPath, [
        { type: 'user', message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/notes.md' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'PreToolUse:Write hook error: [bash …opus-write-nudge.sh]: This Opus thread is about to write source (/repo/notes.md) with no `implementer` dispatch this turn. …' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
      ].map((e) => JSON.stringify(e)).join('\n'));
      return spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    };
    const silent = runNudged('Notes updated.');
    assert.equal(silent.status, 2);
    assert.match(silent.stderr, /IMPLEMENTER NUDGE UNANSWERED/);
    assert.equal(runNudged('implementer: dispatching\nNotes updated.').status, 0);
  });

  await t.test('tool output quoting the write-block text is not a block', () => {
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/notes.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'diff output quoting: This Opus thread is about to write source (/repo/notes.md) with no `implementer` dispatch this turn.' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Notes updated.' }] } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const { status, stderr } = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath }), encoding: 'utf8' });
    assert.equal(status, 0, stderr);
  });

  await t.test('reads verdicts from last_assistant_message when the transcript lags', () => {
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'pnpm lint && node --test && git commit -m x' } }] } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const payload = (extra) => JSON.stringify({ transcript_path: transcriptPath, ...extra });
    assert.equal(spawnSync('bash', [HOOK_PATH], { input: payload({}), encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync('bash', [HOOK_PATH], { input: payload({ last_assistant_message: `Done: edits landed.\n${BASE_VERDICTS}` }), encoding: 'utf8' }).status, 0);
  });

  await t.test('an implementer hand-back counts as a code change: the claim needs evidence and every lens', () => {
    for (const handback of [handBack('implementer'), handBackAttachment('implementer')]) {
      const { status, stderr } = runFull('Done: step 1 landed.', { editedFile: null, handback });
      assert.equal(status, 2);
      assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    }
    assert.equal(run(`Done: step 1 landed.\n${LEARN_SKIP}`, { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js', reviews: LENS_AGENTS }), 0);
    assert.equal(run('Done: step 1 landed.', { editedFile: null, handback: handBack('checker') }), 0);
    assert.equal(run('Done: step 1 landed.', { editedFile: null, handback: handBackAttachment('checker') }), 0);
  });

  await t.test('in a plan build a done-claim with hand-written findings lines stays blocked; a skip with a reason passes', () => {
    const built = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js' };
    const { status, stderr } = runFull('Done: step 1 landed.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', built);
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:[\s\S]*on a done-claim or shipping commit in a plan build a hand pass does not count/);
    assert.equal(run(`Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}`, built), 0);
  });

  await t.test('in a plan build a first line opening "Step N" is a step claim and passes on hand-pass lens lines', () => {
    const built = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js' };
    const handPass = 'reuse-analyzer: 0 findings\nplacement-analyzer: 0 findings';
    assert.equal(run(`Step 1 passes verify: 3,057 tests green.\n${handPass}`, built), 0);
    assert.equal(run(`**Step 3** is built and passes the full verify.\n${handPass}`, built), 0);
    const { status, stderr } = runFull('Step 2 passes verify.', built);
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer/);
    assert.doesNotMatch(stderr, /hand pass does not count/);
  });

  await t.test('a shipping commit that deletes the repo plan file needs each lens dispatched or skipped, with no hand-back', () => {
    const ship = { editedFile: null, lint: false, bashCommand: 'git rm docs/plans/demo.md && git commit -m ship' };
    const { status, stderr } = runFull('Shipped.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', ship);
    assert.equal(status, 2);
    assert.match(stderr, /REVIEW NOT RUN for reuse-analyzer, placement-analyzer:[\s\S]*shipping commit in a plan build a hand pass does not count/);
    assert.equal(run(`Shipped.\n${LEARN_SKIP}`, { ...ship, reviews: LENS_AGENTS }), 0);
    assert.equal(run('Shipped.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', { ...ship, bashCommand: 'git rm docs/notes.md && git commit -m x' }), 0);
  });

  await t.test('a plan build done-claim or shipping commit needs one /learn pass in the transcript, or a learn skip line', () => {
    const built = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js', reviews: LENS_AGENTS };
    const { status, stderr } = runFull('Done: step 1 landed.', built);
    assert.equal(status, 2);
    assert.match(stderr, /LEARN NOT RUN/);
    const typed = '<command-message>learn</command-message>\n<command-name>/learn</command-name>';
    assert.equal(run('Done: step 1 landed.', { ...built, prompt: typed }), 0);
    assert.equal(run('Done: step 1 landed.', { ...built, reviews: [...LENS_AGENTS, { type: 'tool_use', name: 'Skill', input: { skill: 'learn' } }] }), 0);
    assert.equal(run(`Done: step 1 landed.\n${LEARN_SKIP}`, built), 0);
    // Near twins: a step claim, and a code edit with no hand-back, are not the build's done-claim.
    assert.doesNotMatch(runFull('Step 1 passes verify.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings', { ...built, reviews: [] }).stderr, /LEARN NOT RUN/);
    assert.doesNotMatch(runFull('Done: typo fixed.', { bashCommand: 'node --test tests/*.test.js', reviews: LENS_AGENTS }).stderr, /LEARN NOT RUN/);
    const ship = { editedFile: null, lint: false, bashCommand: 'git rm docs/plans/demo.md && git commit -m ship', reviews: LENS_AGENTS };
    assert.match(runFull('Shipped.', ship).stderr, /LEARN NOT RUN/);
    assert.equal(run(`Shipped.\n${LEARN_SKIP}`, ship), 0);
  });

  await t.test('a hand-back keys the lint demand on the files its agent transcript shows it wrote; with no transcript named, the cwd decides', () => {
    const scripted = repoWith({ 'check:lint': 'oxlint .' });
    const tested = { command: 'node --test tests/*.test.js', output: 'ℹ fail 0' };
    const agentRun = (id, files) => {
      const out = path.join(tmpDir, `${id}.output`);
      fs.writeFileSync(out, files.map((f) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: f } }] } })).join('\n'));
      const hb = handBack('implementer');
      hb.origin.from = id;
      return [
        { blocks: [{ type: 'tool_use', id: `dispatch-${id}`, name: 'Agent', input: { subagent_type: 'implementer' } }] },
        { record: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `dispatch-${id}`, content: `Async agent launched.\noutput_file: ${out}` }] } } },
        { handback: hb },
        tested,
      ];
    };
    const opts = { editedFile: null, lint: false, cwd: scripted };
    const reply = `Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}`;
    assert.doesNotMatch(runWithResults(reply, agentRun('ag1', [path.join(os.homedir(), '.claude/hooks/x.sh')]), opts).stderr, /LINT\/TSC/);
    assert.match(runWithResults(reply, agentRun('ag2', ['/repo/src/app.ts']), opts).stderr, /LINT\/TSC/);
    assert.match(runWithResults(reply, [{ handback: handBack('implementer') }, tested], opts).stderr, /LINT\/TSC/);
    const gone = agentRun('ag3', ['/repo/src/app.ts']);
    fs.rmSync(path.join(tmpDir, 'ag3.output'));
    assert.match(runWithResults(reply, gone, opts).stderr, /LINT\/TSC/);
  });

  await t.test('in a plan build a REPORT passes on hand-pass lens lines', () => {
    const report = `[REPORT demo step 1] Step 1 built.\nreuse-analyzer: 0 findings\nplacement-analyzer: 0 findings\n${RAW_OUTPUT}`;
    assert.equal(run(report, { editedFile: null, handback: handBack('implementer'), send: true, lint: false, bashCommand: 'node --test tests/*.test.js' }), 0);
  });

  await t.test('a hand-back needs lint and type check only where the repo defines a lint or type-check script', () => {
    const opts = { editedFile: null, handback: handBack('implementer'), bashCommand: 'node --test tests/*.test.js', lint: false };
    const reply = `Done: step 1 landed.\n${LENS_SKIPS}`;
    const scripted = repoWith({ 'check:lint': 'eslint .' });
    assert.match(runFull(reply, { ...opts, cwd: scripted }).stderr, /LINT\/TSC NOT RUN/);
    assert.doesNotMatch(runFull(reply, { ...opts, cwd: repoWith({ build: 'vite build' }) }).stderr, /LINT\/TSC/);
    assert.doesNotMatch(runFull(reply, { ...opts, cwd: path.join(os.homedir(), '.claude') }).stderr, /LINT\/TSC/);
    assert.doesNotMatch(runFull(reply, { ...opts, cwd: scripted, bashCommand: 'node --test tests/*.test.js && pnpm lint' }).stderr, /LINT\/TSC/);
    spawnSync('git', ['init', '-q'], { cwd: scripted });
    const nested = path.join(scripted, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    assert.match(runFull(reply, { ...opts, cwd: nested }).stderr, /LINT\/TSC NOT RUN/);
    const repoPlan = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'implementer', prompt: `Implement step 1 of ${scripted}/plans/x.md` } };
    assert.match(runFull(reply, { ...opts, cwd: scripted, reviews: [repoPlan] }).stderr, /LINT\/TSC NOT RUN/);
  });

  await t.test('a harness plan dispatched before a typed prompt does not waive lint in a repo that defines it', () => {
    const transcriptPath = path.join(tmpDir, `t${nextSeq()}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      { type: 'user', message: { content: 'implement' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'implementer', prompt: 'Implement step 1 of ~/.claude/plans/x.md' } }] } },
      { type: 'user', message: { content: 'how is it going?' } },
      handBack('implementer'),
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'node --test tests/*.test.js' } },
        { type: 'text', text: `Done: step 1 landed.\n${LENS_SKIPS}\n${LEARN_SKIP}` },
      ] } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const stop = (cwd) => spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ transcript_path: transcriptPath, cwd }), encoding: 'utf8' });
    const scripted = stop(repoWith({ lint: 'eslint .' }));
    assert.equal(scripted.status, 2);
    assert.match(scripted.stderr, /LINT\/TSC NOT RUN/);
    const unscripted = stop(repoWith({ build: 'vite build' }));
    assert.doesNotMatch(unscripted.stderr, /LINT\/TSC/);
    assert.equal(unscripted.status, 0, unscripted.stderr);
  });

  await t.test('the claim comes from the final reply, not the first text of the turn', () => {
    const { status, stderr } = runFull('Done: the edits landed.', { reviews: [{ type: 'text', text: 'Working on it.' }] });
    assert.equal(status, 2);
    assert.match(stderr, /DONE-CLAIM WITHOUT EVIDENCE/);
    assert.equal(run('Still red: two tests fail.', { reviews: [{ type: 'text', text: 'Done: the edits landed.' }] }), 0);
  });
});
