'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'new-dep-gate.js');

// Under $HOME, not os.tmpdir(): the hook exempts temp paths, so a fixture there would always pass.
const repo = fs.mkdtempSync(path.join(os.homedir(), '.new-dep-gate-test-'));
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

const pkgFile = path.join(repo, 'package.json');
const BASE = JSON.stringify({
  name: 'app',
  dependencies: { react: '^18.2.0', '@app/ui': 'workspace:*' },
  devDependencies: { vitest: '^1.0.0' },
}, null, 2);

function run(tool, toolInput, cwd = repo) {
  fs.writeFileSync(pkgFile, BASE);
  const res = spawnSync('node', [HOOK_PATH], { input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd }), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout && JSON.parse(res.stdout).hookSpecificOutput;
}

const edit = (old_string, new_string, extra = {}) => run('Edit', { file_path: pkgFile, old_string, new_string, ...extra });
const bash = (command, cwd) => run('Bash', { command }, cwd);

test('new dependency gate', async (t) => {
  await t.test('asks when an Edit adds a package, naming it', () => {
    const out = edit('"react": "^18.2.0"', '"react": "^18.2.0",\n    "left-pad": "^1.0.0"');
    assert.equal(out.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, /New dependency: left-pad\. CLAUDE\.md dependency ladder/);
  });

  await t.test('asks when a Write adds a package', () => {
    const content = BASE.replace('"vitest": "^1.0.0"', '"vitest": "^1.0.0",\n    "msw": "^2.0.0"');
    assert.match(run('Write', { file_path: pkgFile, content }).permissionDecisionReason, /New dependency: msw\./);
  });

  await t.test('passes bumps, removals, moves between fields and local specs', () => {
    assert.equal(edit('"react": "^18.2.0"', '"react": "^18.3.0"'), '');
    assert.ok(BASE.includes('"react": "^18.2.0",\n    '));
    assert.equal(edit('"react": "^18.2.0",\n    ', ''), '');
    const moved = JSON.stringify({ name: 'app', dependencies: { react: '^18.2.0', '@app/ui': 'workspace:*', vitest: '^1.0.0' } });
    assert.equal(run('Write', { file_path: pkgFile, content: moved }), '');
    assert.equal(edit('"react": "^18.2.0"', '"react": "^18.2.0",\n    "@app/core": "workspace:*",\n    "local": "file:../local"'), '');
  });

  await t.test('passes non-package.json files, scratch package.json and unparsable edits', () => {
    assert.equal(run('Edit', { file_path: path.join(repo, 'tsconfig.json'), old_string: 'a', new_string: 'b' }), '');
    assert.equal(run('Write', { file_path: '/private/tmp/x/package.json', content: '{"dependencies":{"x":"1"}}' }), '');
    assert.equal(edit('"react": "^18.2.0"', '"react": "^18.2.0", "left-pad":'), '');
  });

  await t.test('asks on third-party install commands', () => {
    for (const command of ['npm i x', 'pnpm add -D x', 'yarn add x', 'bun add x', 'npm install -g x', 'flutter pub add x', 'dart pub add x', 'pnpm --filter web add @tanstack/react-query', 'npm ci && npm i lodash',
      'npm i lodash --workspace=apps/web', 'npm i lodash -w apps/web', 'pnpm add lodash --workspace-root', 'npm i lodash && cd /tmp/x',
      'pnpm -C apps/web add zod', 'pnpm --dir=apps/web add zod', 'yarn workspace web add zod', 'pnpm add zod 2>&1 | tail -3']) {
      assert.equal(bash(command)?.permissionDecision, 'ask', command);
    }
  });

  await t.test('passes restores, chained non-installs, local paths, workspaces and scratch installs', () => {
    for (const command of [
      'pnpm install', 'npm ci', 'yarn', 'npm install --package-lock-only',
      'npm i && npm test', 'npm ci; npm run build', 'pnpm install > log',
      'npm test && git add src/x.ts', 'npm run install-deps', 'npm i ./pkg', 'pnpm add x --workspace',
      'cd /private/tmp/claude-501/s && npm i left-pad',
      'pnpm install --silent 2>&1 | tail -2', 'pnpm install --offline 2>&1', 'npm i 2>/dev/null', 'pnpm icons:generate add 2>&1',
      'pnpm icons:generate add arrow-left',
    ]) {
      assert.equal(bash(command), '', command);
    }
    assert.equal(bash('npm i left-pad', '/private/tmp/claude-501/scratchpad'), '');
  });

  await t.test('passes first-party @additiv packages, asks when a third-party one rides along', () => {
    assert.equal(edit('"react": "^18.2.0"', '"react": "^18.2.0",\n    "@additiv-hydrogen/data.wealth.rest.use-questionnaires": "^1.0.0"'), '');
    assert.match(edit('"react": "^18.2.0"', '"react": "^18.2.0",\n    "@additiv-hayah/ui": "^1.0.0",\n    "lodash": "^4.0.0"').permissionDecisionReason, /New dependency: lodash\./);
    assert.match(edit('"react": "^18.2.0"', '"react": "^18.2.0",\n    "@additivx/ui": "^1.0.0"').permissionDecisionReason, /@additivx\/ui/);
    for (const command of ['npm i @additiv-hydrogen/data.wealth.rest.use-questionnaires@1.2.0', 'pnpm add -D @additiv-hayah/ui 2>&1 | tail -3', 'npm ci && npm i @additiv/core']) {
      assert.equal(bash(command), '', command);
    }
    for (const command of ['npm i @additiv-hydrogen/x lodash', 'npm i @additiv-hydrogen/x && pnpm add zod', 'npm i @additiv-hydrogen/x -w apps/web', 'npm i @additivx/core']) {
      assert.equal(bash(command)?.permissionDecision, 'ask', command);
    }
  });
});
