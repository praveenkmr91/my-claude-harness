'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'docs-context.sh');

let seq = 0;
const newSession = () => `docs-ctx-test-${process.pid}-${seq++}`;

test.after(() => {
  for (let i = 0; i < seq; i++) fs.rmSync(`/tmp/claude-docs-ctx-docs-ctx-test-${process.pid}-${i}`, { force: true });
});

function run(sessionId, toolName, toolInput) {
  const payload = { session_id: sessionId, tool_name: toolName, tool_input: toolInput };
  const res = spawnSync('bash', [HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.stdout;
}

const injects = (out) => assert.match(out, /library-docs\.md — injected once/);
const silent = (out) => assert.equal(out, '');

test('docs context hook', async (t) => {
  await t.test('Edit adding a bare-specifier import fires', () => {
    injects(run(newSession(), 'Edit', { new_string: "import { z } from 'zod';" }));
  });

  await t.test('Write with a scoped package import fires', () => {
    injects(run(newSession(), 'Write', { content: 'import { useForm } from "@tanstack/react-form";' }));
  });

  await t.test('Edit adding only a relative import is silent', () => {
    silent(run(newSession(), 'Edit', { new_string: "import { x } from './x';\nimport y from '../y';" }));
  });

  await t.test('WebFetch to a docs site fires', () => {
    injects(run(newSession(), 'WebFetch', { url: 'https://react.dev/reference/react/use' }));
  });

  await t.test('WebFetch to GitHub is silent — already the tag rung', () => {
    silent(run(newSession(), 'WebFetch', { url: 'https://github.com/vitejs/vite/blob/v8.3.0/docs/config.md' }));
  });

  await t.test('context7 and WebSearch fire', () => {
    injects(run(newSession(), 'mcp__plugin_context7_context7__query-docs', { libraryId: '/vitejs/vite' }));
    injects(run(newSession(), 'WebSearch', { query: 'vite 8 config' }));
  });

  await t.test('second trigger in the same session is silent', () => {
    const sessionId = newSession();
    injects(run(sessionId, 'WebSearch', { query: 'a' }));
    silent(run(sessionId, 'Edit', { new_string: "import x from 'x';" }));
  });

  await t.test('Read and missing session_id are silent', () => {
    silent(run(newSession(), 'Read', { file_path: '/tmp/a.ts' }));
    silent(run(undefined, 'WebSearch', { query: 'a' }));
  });
});
