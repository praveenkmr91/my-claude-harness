'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', '..', 'hooks', 'block-dangerous-git.sh');

// Under the pre-commit hook git exports GIT_INDEX_FILE etc.; inherited, they point the scratch repo at ~/.claude's index.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function run(command, cwd = '/Users/me/repo') {
  const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify({ tool_input: { command }, cwd }), encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const decision = (stdout) => stdout && JSON.parse(stdout).hookSpecificOutput.permissionDecision;

module.exports = {
  HOOK_PATH,
  env,
  run,
  decision,
};
