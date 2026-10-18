#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCRATCH = /^(\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|\/dev\/)/;
const TMP_DIR = String.raw`["']?(/private)?/(tmp|var/folders)/`;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const LOCAL_SPEC = /^(workspace|file|link):/;
const INTERNAL = /^@additiv(-[\w-]+)?\//;
// The `2` of `pnpm install 2>&1` reads as a package name, and `pnpm <script> add` as an install, unless both are excluded.
const JS_INSTALL = /\b(npm|pnpm|yarn|bun)(?:\s+(?:-{1,2}\w[\w-]*(?:=\S+)?(?:\s+(?!(?:add|install|i)\s)[^-\s;&|]\S*)?|workspace\s+\S+))*\s+(add|install|i)\s+(?:-\S+\s+)*(?!\d*[<>])[@A-Za-z0-9_]/;
const PUB_ADD = /\b(flutter|dart)\s+pub\s+add\s+[A-Za-z0-9_]/;

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { tool_name: tool, tool_input: args = {}, cwd = '' } = input;

function ask(what) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `New dependency: ${what}. CLAUDE.md dependency ladder: name the cost and get a yes first.`,
    },
  }));
}

function depNames(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return null; }
  const names = new Map();
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) names.set(name, String(spec));
  }
  return names;
}

function addedPackages() {
  const file = args.file_path ?? '';
  if (path.basename(file) !== 'package.json' || SCRATCH.test(file)) return [];
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
  let after;
  if (tool === 'Write') after = args.content ?? '';
  else if (args.replace_all) after = before.split(args.old_string).join(args.new_string);
  else after = before.replace(args.old_string, () => args.new_string);
  const oldNames = depNames(before);
  const newNames = depNames(after);
  if (!oldNames || !newNames) return [];
  return [...newNames].filter(([name, spec]) => !oldNames.has(name) && !LOCAL_SPEC.test(spec) && !INTERNAL.test(name)).map(([name]) => name);
}

function installsThirdParty() {
  const command = args.command ?? '';
  const installs = command.split(/&&|\|\||[;|]/).filter((part) => JS_INSTALL.test(part) || PUB_ADD.test(part));
  if (!installs.length) return false;
  // A flag value such as `-w apps/web` reads as a package name here, so it keeps the gate closed rather than open.
  const packages = installs.flatMap((part) => {
    const words = part.trim().split(/\s+/);
    const afterVerb = words.slice(words.findIndex((word) => /^(add|install|i)$/.test(word)) + 1);
    return afterVerb.filter((word) => !word.startsWith('-') && !/^\d*[<>]/.test(word));
  });
  if (packages.every((name) => INTERNAL.test(name))) return false;
  // pnpm's bare --workspace links a workspace package; npm's --workspace=<dir> and pnpm's --workspace-root install third-party deps.
  if (/\bpnpm\b.*\s--workspace(\s|$)/.test(command)) return false;
  if (new RegExp(`^${TMP_DIR}`).test(cwd)) return false;
  return !new RegExp(`^\\s*cd\\s+${TMP_DIR}`).test(command);
}

if (tool === 'Bash') {
  if (installsThirdParty()) ask(`install command \`${args.command}\``);
} else {
  const added = addedPackages();
  if (added.length) ask(added.join(', '));
}
