#!/usr/bin/env node
// PreToolUse on Bash. Every file-quality hook is keyed to Write|Edit, so a file written by
// heredoc, redirect, tee, an inline interpreter script, or staged in scratch and copied in skips all of them.
'use strict';

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|swift|kts?|dart|css|scss|html|json|ya?ml|toml|mdx?|csv|sh)$/;
const DOTFILE = /(^|\/)\.[\w.-]+$/;
const SCRATCH = /^(\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|\/dev\/)/;
const TOKEN = String.raw`[^\s'"|;&<>()]+`;
// Lookbehind keeps arrows (=>, ->) in commit messages from reading as redirects.
const REDIRECT = new RegExp(String.raw`(?<![=\-<>])>>?\|?\s*(['"]?)(${TOKEN})\1`, 'g');
const TEE = new RegExp(String.raw`\btee\s+(?:-a\s+)?(['"]?)(${TOKEN})\1`, 'g');
const COPY = /(?<!git\s)\b(?:cp|mv|install)\s+((?:[^\s|;&<>()]+\s+)*?)([^\s|;&<>()]+)(?=\s*(?:$|[|;&)]))/gm;
const CD = new RegExp(String.raw`\bcd\s+(['"]?)(${TOKEN})\1`, 'g');
const SHELL_ASSIGN = new RegExp(String.raw`(?:^|[\s;&(])([A-Za-z_]\w*)=(['"]?)(${TOKEN})\2`, 'gm');
const HEREDOC_BODY = /^([^\n]*<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\s*\3(?=\n|$)/gm;

const INTERPRETER = /\b(?:python3?|node|ruby)(?:\s+--?[\w=-]+)*\s+(?:-[ce]\b|-(?:\s+[^\s<|;&]+)*\s*<<|<<)/;
const INTERPRETER_WRITE =
  /write_text|write_bytes|writeFileSync|appendFileSync|writeFile\(|copyFileSync|renameSync|shutil\.|copyfile|open\([^)]*,\s*['"][wax]|\.write\(/;
const WRITE_CALL_ARG = [
  /open\(\s*([^,()]+?)\s*,\s*['"][wax]/g,
  /(?:writeFileSync|appendFileSync|writeFile)\(\s*([^,()]+?)\s*,/g,
  /Path\(\s*([^()]+?)\s*\)\.write_(?:text|bytes)/g,
  /\b(\w+)\.write_(?:text|bytes)/g,
  /(?:shutil\.\w+|copyfile|copyFileSync|renameSync)\([^,()]+,\s*([^,()]+?)\s*[,)]/g,
];
const PY_STRING_ASSIGN = /\b(\w+)\s*=\s*(?:(?:pathlib\.)?Path\(\s*)?(['"])([^'"\n]+)\2/g;
const PY_ALIAS_ASSIGN = /\b(\w+)\s*=\s*(?:pathlib\.)?Path\(\s*(\w+)\s*\)/g;
const PATH_TOKEN = /[\w.~$\/-]+\.[A-Za-z]+\b/g;

function shellVars(command) {
  const vars = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  for (const m of command.matchAll(SHELL_ASSIGN)) vars[m[1]] = m[3];
  return vars;
}

const expand = (target, vars) =>
  target.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name) => vars[name] ?? whole).replace(/^~(?=\/)/, process.env.HOME);

function cwdAt(index, command, vars, sessionCwd) {
  let cwd = sessionCwd;
  for (const m of command.matchAll(CD)) if (m.index < index) cwd = expand(m[2], vars);
  return cwd;
}

function isGuarded(target, cwd) {
  const inScratch = SCRATCH.test(target) || (!target.startsWith('/') && SCRATCH.test(`${cwd}/`));
  return (SOURCE_EXT.test(target) || DOTFILE.test(target)) && !inScratch;
}

function shellTargets(command, vars, sessionCwd) {
  const found = [];
  for (const m of [...command.matchAll(REDIRECT), ...command.matchAll(TEE)]) {
    const target = expand(m[2], vars);
    if (isGuarded(target, cwdAt(m.index, command, vars, sessionCwd))) found.push(target);
  }
  for (const m of command.matchAll(COPY)) {
    const sources = m[1].trim().split(/\s+/).filter((s) => s && !s.startsWith('-')).map((s) => expand(s, vars));
    const dest = expand(m[2], vars);
    const cwd = cwdAt(m.index, command, vars, sessionCwd);
    // Judged by where it lands, since a staged file can carry any name. A scratch .bak restored over
    // its original is a revert, not authored content.
    for (const source of sources.filter((s) => SCRATCH.test(s) && !s.endsWith('.bak'))) {
      const isFile = SOURCE_EXT.test(dest) || DOTFILE.test(dest);
      const landed = isFile ? dest : `${dest.replace(/\/$/, '')}/${source.split('/').pop()}`;
      if (isGuarded(landed, cwd)) found.push(landed);
    }
  }
  return found;
}

function resolvePyArg(arg, pyVars, aliases) {
  const literal = arg.match(/^(['"])(.+)\1$/);
  if (literal) return literal[2];
  let name = arg;
  for (let hops = 0; aliases[name] && hops < 5; hops++) name = aliases[name];
  return pyVars[name];
}

function interpreterTargets(command, vars, sessionCwd) {
  const invocation = command.search(INTERPRETER);
  if (invocation === -1 || !INTERPRETER_WRITE.test(command)) return [];
  const cwd = cwdAt(invocation, command, vars, sessionCwd);

  const pyVars = {};
  const aliases = {};
  for (const m of command.matchAll(PY_STRING_ASSIGN)) pyVars[m[1]] = m[3];
  for (const m of command.matchAll(PY_ALIAS_ASSIGN)) aliases[m[1]] = m[2];

  const args = WRITE_CALL_ARG.flatMap((re) => [...command.matchAll(re)].map((m) => m[1]));
  const resolved = args.map((arg) => resolvePyArg(arg, pyVars, aliases));
  // An unresolved destination (loop variable, function parameter) can't be proven scratch. The sweep
  // skips dotfiles: in code, `.test(` and `~/.claude` read as dotfile paths.
  const swept = (command.match(PATH_TOKEN) || []).filter((t) => SOURCE_EXT.test(t));
  const candidates = args.length > 0 && resolved.every(Boolean) ? resolved : swept;
  return candidates.map((t) => expand(t, vars)).filter((t) => isGuarded(t, cwd));
}

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  const shellOnly = command.replace(HEREDOC_BODY, '$1');
  // A script heredoc'd into a file hasn't run yet; only a body piped straight into an interpreter executes.
  const executed = command.replace(HEREDOC_BODY, (body, opener) => (INTERPRETER.test(opener) ? body : opener));
  const vars = shellVars(shellOnly);
  const sessionCwd = input.cwd ?? '';
  const targets = [
    ...new Set([...shellTargets(shellOnly, vars, sessionCwd), ...interpreterTargets(executed, vars, sessionCwd)]),
  ];
  if (targets.length === 0) process.exit(0);

  process.stderr.write(
    `BLOCKED: shell write to ${targets.join(', ')}. Use Write or Edit to create or change source, config and doc files — ` +
      'the Write|Edit hooks (comment check, util guard, implementer nudge, review lenses) never see a heredoc, redirect, ' +
      'tee, inline-script or copy-from-scratch write. sed -i one-liners, git mv, and output under /tmp or the scratchpad stay allowed.\n',
  );
  process.exit(2);
});
