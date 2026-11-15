'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { HOOK_PATH, env, run, decision } = require('./helpers/block-dangerous-git');

test('block dangerous git hook: globs pr', async (t) => {
  await t.test('quotes an unquoted grep glob without deciding permission', () => {
    for (const [command, quoted] of [
      ['grep -rn foo --include=*.tsx .', "grep -rn foo --include='*.tsx' ."],
      ['cd src && grep -r x --include=*.ts .', "cd src && grep -r x --include='*.ts' ."],
      ['grep -rn foo --exclude=*.min.js --exclude-dir=node_modules .', "grep -rn foo --exclude='*.min.js' --exclude-dir=node_modules ."],
      ['grep -rn foo --include=src/*.ts .', "grep -rn foo --include='src/*.ts' ."],
      ['grep -rn foo --include=*.ts --include=*.tsx src | head', "grep -rn foo --include='*.ts' --include='*.tsx' src | head"],
    ]) {
      const { status, stdout } = run(command);
      assert.equal(status, 0, command);
      const output = JSON.parse(stdout).hookSpecificOutput;
      assert.equal(output.updatedInput.command, quoted);
      assert.equal(output.permissionDecision, undefined, command);
    }
  });

  await t.test('a quoted glob keeps the rest of tool_input and still asks before a PR', () => {
    const res = spawnSync('bash', [HOOK_PATH], {
      input: JSON.stringify({ tool_input: { command: 'grep -r x --include=*.md . && gh pr create --fill', description: 'd', timeout: 5 } }),
      encoding: 'utf8',
      env,
    });
    const output = JSON.parse(res.stdout).hookSpecificOutput;
    assert.deepEqual(output.updatedInput, { command: "grep -r x --include='*.md' . && gh pr create --fill", description: 'd', timeout: 5 });
    assert.equal(output.permissionDecision, 'ask');
  });

  await t.test('passes quoted, escaped, brace and glob-free forms', () => {
    for (const command of [
      "grep -rn foo --include='*.tsx' .",
      'grep -rn foo --include="*.tsx" .',
      'grep -rn foo --include=\\*.tsx .',
      'grep -rn foo --include=src .',
      'grep -rn foo --exclude-dir={a,b} .',
      'grep -rn foo --exclude-dir=node_modules .',
    ]) {
      assert.equal(run(command).status, 0, command);
    }
  });

  await t.test('asks before a PR, whatever flags precede it', () => {
    for (const command of ['gh pr create --title x --body y', 'gh pr create --title x --body-file /tmp/b.md', 'gh -R org/app pr create --title x', 'cd app && gh pr create --fill']) {
      const { status, stdout } = run(command);
      assert.equal(status, 0, command);
      assert.equal(decision(stdout), 'ask', command);
    }
  });
});
