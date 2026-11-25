'use strict';

const { spawn } = require('node:child_process');

const SUITE_CONCURRENCY = 8;

// A sync launch inside a concurrent describe stalls every other case in the file.
const launch = (command, args = [], { input, cwd, env, timeout } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, timeout });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') reject(error);
  });
  child.on('error', reject);
  child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  child.stdin.end(input ?? undefined);
});

const launchChecked = async (command, args, options) => {
  const { status, signal, stdout, stderr } = await launch(command, args, options);
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${status ?? signal}: ${stderr}`);
  return stdout;
};

module.exports = { SUITE_CONCURRENCY, launch, launchChecked };
