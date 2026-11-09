#!/usr/bin/env node
// PreToolUse on Bash. Every file-quality hook is keyed to Write|Edit, so a file written by
// heredoc, redirect, tee, an inline interpreter script, or staged in scratch and copied in skips all of them.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|swift|kts?|dart|css|scss|html|json|ya?ml|toml|mdx?|csv|sh)$/;
const DOTFILE = /(^|\/)\.[\w.-]+$/;
const SCRATCH = /^(\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|\/dev\/)/;
const TOKEN = String.raw`[^\s'"|;&<>()\`]+`;
// Lookbehind keeps arrows (=>, ->) in commit messages from reading as redirects.
const REDIRECT = new RegExp(String.raw`(?<![=\-<>])>>?\|?\s*(['"]?)(${TOKEN})\1`, 'g');
const TEE = new RegExp(String.raw`\btee\s+(?:-a\s+)?(['"]?)(${TOKEN})\1`, 'g');
const COPY = /(?<!git\s)\b(?:cp|mv|install)\s+((?:[^\s|;&<>()]+\s+)*?)([^\s|;&<>()]+)(?=\s*(?:$|[|;&)]))/gm;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g;
const NESTED_SHELL = /(?:\b(?:sh|bash|zsh)\s+(?:-\w+\s+)*-\w*c|\beval)\s*$/;
const SUBSTITUTION = /\$\(|`/;
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
const SCRIPT_START = /\b(?:python3?|node)(?:\s+--?[\w=-]+)*\s+-[ce]\s+(['"])/g;
const SCRIPT_END = { "'": /[^']*'/y, '"': /(?:[^"\\]|\\[\s\S])*"/y };
const POSITIONAL = /[ \t]+((?:'[^']*'|"[^"]*"|[^\s'"|;&<>()])+)/y;
const ARGV_REF = /^(?:process|sys)\.argv\[(\d+)\]$/;
const PATH_TOKEN = /[\w.~$\/-]+\.[A-Za-z]+\b/g;
const SED_I = /^\s*(?:\w+=\S*\s+)*sed\s(?:\S+\s)*?(?:-[A-Za-z]*i\S*|--in-place\S*)(?=\s|$)/;
const PERL_I = /^\s*(?:\w+=\S*\s+)*perl\s(?:\S+\s)*?-[A-Za-z]*i\S*(?=\s|$)/;
const GIT_MV = /^\s*(?:\w+=\S*\s+)*git\s+mv\s/;
const GIT_RM = /^\s*(?:\w+=\S*\s+)*git\s+rm\s/;
const FED_EDITOR = /^\s*(?:xargs(?:\s+-\S+)*\s+|.*?\s-exec(?:dir)?\s+)/;
const NUDGE = path.join(__dirname, 'opus-write-nudge.sh');
const DIR_WALK_CAP = 500;
const REPO_PLANS = /(^|\/)plans\/[^/]+\.md$/;
const RELATIVE_PATH = /^[\w.\/-]+$/;
const MEMORY = /\/\.claude\/projects\/[^/]+\/memory\//;

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
  const inMemory = MEMORY.test(target.startsWith('/') ? target : `${cwd}/${target}`);
  return (SOURCE_EXT.test(target) || DOTFILE.test(target)) && !inScratch && !inMemory;
}

// A quoted string is data, not shell syntax, unless a nested shell runs it or a double-quoted
// command substitution executes inside it.
function maskQuoted(command) {
  return command.replace(QUOTED, (span, offset) => {
    const runsAsShell = NESTED_SHELL.test(command.slice(0, offset)) || (span[0] === '"' && SUBSTITUTION.test(span));
    return runsAsShell ? span : `${span[0]}${'_'.repeat(span.length - 2)}${span[0]}`;
  });
}

// Operators are located on the masked text; targets are captured from the original at the same index.
function operatorMatches(pattern, command, masked) {
  const sticky = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}y`);
  const found = [];
  for (const m of masked.matchAll(pattern)) {
    sticky.lastIndex = m.index;
    const real = sticky.exec(command);
    if (real) found.push(real);
  }
  return found;
}

function shellTargets(command, vars, sessionCwd) {
  const found = [];
  const masked = maskQuoted(command);
  for (const m of [...operatorMatches(REDIRECT, command, masked), ...operatorMatches(TEE, command, masked)]) {
    const target = expand(m[2], vars);
    if (isGuarded(target, cwdAt(m.index, command, vars, sessionCwd))) found.push(target);
  }
  for (const m of operatorMatches(COPY, command, masked)) {
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

function scriptPositionals(command, writeIndex) {
  for (const start of command.matchAll(SCRIPT_START)) {
    const bodyStart = start.index + start[0].length;
    const closing = SCRIPT_END[start[1]];
    closing.lastIndex = bodyStart;
    const body = closing.exec(command);
    if (!body) continue;
    const bodyEnd = bodyStart + body[0].length;
    if (writeIndex < bodyStart || writeIndex >= bodyEnd) continue;
    const positionals = [];
    POSITIONAL.lastIndex = bodyEnd;
    for (let m = POSITIONAL.exec(command); m; m = POSITIONAL.exec(command)) positionals.push(m[1].replace(/['"]/g, ''));
    return positionals;
  }
  return [];
}

function resolveArgvArg(arg, writeIndex, command, vars) {
  const ref = arg.match(ARGV_REF);
  if (!ref) return undefined;
  const positional = scriptPositionals(command, writeIndex)[Number(ref[1]) - 1];
  if (positional === undefined) return undefined;
  const value = expand(positional, vars);
  return /[$`]/.test(value) ? undefined : value;
}

function interpreterTargets(command, vars, sessionCwd) {
  const invocation = command.search(INTERPRETER);
  if (invocation === -1 || !INTERPRETER_WRITE.test(command)) return [];
  const cwd = cwdAt(invocation, command, vars, sessionCwd);

  const pyVars = {};
  const aliases = {};
  for (const m of command.matchAll(PY_STRING_ASSIGN)) pyVars[m[1]] = m[3];
  for (const m of command.matchAll(PY_ALIAS_ASSIGN)) aliases[m[1]] = m[2];

  const args = WRITE_CALL_ARG.flatMap((re) => [...command.matchAll(re)].map((m) => ({ arg: m[1], index: m.index })));
  const resolved = args.map(
    ({ arg, index }) => resolvePyArg(arg, pyVars, aliases) ?? resolveArgvArg(arg, index, command, vars),
  );
  // An unresolved destination (loop variable, function parameter) can't be proven scratch. The sweep
  // skips dotfiles: in code, `.test(` and `~/.claude` read as dotfile paths.
  const swept = (command.match(PATH_TOKEN) || []).filter((t) => SOURCE_EXT.test(t));
  const candidates = args.length > 0 && resolved.every(Boolean) ? resolved : swept;
  return candidates.map((t) => expand(t, vars)).filter((t) => isGuarded(t, cwd));
}

const isPlanPath = (target) => REPO_PLANS.test(target) || target.startsWith(`${process.env.HOME}/.claude/plans/`);

// A relative token is resolved only if it reads as a path: a sed script like s#a#b.md# is not a file.
const isPlanToken = (token, cwd) =>
  !token.startsWith('-') && (token.startsWith('/') || RELATIVE_PATH.test(token)) && isPlanPath(path.resolve(cwd, token));

function planEditTargets(command, vars, sessionCwd) {
  const found = [];
  let cwd = sessionCwd;
  for (const segment of command.split(/[;&|\n]+/)) {
    const tokens = segment.trim().split(/\s+/).map((t) => expand(t.replace(/^['"]|['"]$/g, ''), vars));
    if (tokens[0] === 'cd' && tokens[1] && !tokens[1].startsWith('-')) {
      cwd = path.resolve(cwd, tokens[1]);
      continue;
    }
    if (SED_I.test(segment) || PERL_I.test(segment)) found.push(...tokens.filter((t) => isPlanToken(t, cwd)));
    if (GIT_MV.test(segment) && isPlanToken(tokens[tokens.length - 1], cwd)) found.push(tokens[tokens.length - 1]);
  }
  return found;
}

const argTokens = (segment, vars) =>
  segment.trim().split(/\s+/).map((t) => expand(t.replace(/^['"]|['"]$/g, ''), vars)).filter(Boolean);

// A moved or removed directory is judged by the files inside it: git mv src/core/a src/core/b carries no extension.
function expandDirs(paths) {
  return paths.flatMap((p) => {
    if (!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) return [p];
    return fs.readdirSync(p, { recursive: true }).slice(0, DIR_WALK_CAP).map((f) => path.join(p, String(f)));
  });
}

// Code edits made through the shell, for opus-write-nudge.sh to tier-gate. A sed fed its files by xargs or
// find -exec names none, so it is gated by the directory it runs in.
function shellCodeEdits(command, vars, sessionCwd) {
  const named = [];
  let unresolvedIn;
  let cwd = sessionCwd || process.cwd();
  const masked = maskQuoted(command);
  for (const m of masked.matchAll(/[^;&|\n]+/g)) {
    const segment = command.slice(m.index, m.index + m[0].length);
    const tokens = argTokens(segment, vars);
    if (tokens[0] === 'cd' && tokens[1] && !tokens[1].startsWith('-')) {
      cwd = path.resolve(cwd, tokens[1]);
      continue;
    }
    const fed = m[0].match(FED_EDITOR);
    const editor = fed ? segment.slice(fed[0].length) : segment;
    const args = argTokens(editor, vars);
    if (SED_I.test(editor) || PERL_I.test(editor)) {
      named.push(...args.slice(args.findIndex((t) => t === 'sed' || t === 'perl') + 1).filter((t) => !t.startsWith('-')).map((t) => path.resolve(cwd, t)));
      if (fed) unresolvedIn = `${cwd}/`;
    } else if (GIT_MV.test(segment) || (GIT_RM.test(segment) && !tokens.includes('--cached'))) {
      const operands = tokens.slice(tokens.findIndex((t) => t === 'mv' || t === 'rm') + 1).filter((t) => !t.startsWith('-'));
      const sources = GIT_MV.test(segment) ? operands.slice(0, -1) : operands;
      named.push(...expandDirs(sources.map((t) => path.resolve(cwd, t))));
    }
  }
  return { named, unresolvedIn };
}

function tierGate(input, { named, unresolvedIn }) {
  if (named.length === 0 && !unresolvedIn) return;
  const payload = { ...input, tool_input: { shell_targets: named, unresolved_in: unresolvedIn } };
  const res = spawnSync('bash', [NUDGE], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 4000 });
  if (res.status === 2) {
    process.stderr.write(res.stderr);
    process.exit(2);
  }
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
  const planTargets = [...new Set(planEditTargets(shellOnly, vars, sessionCwd))];
  if (planTargets.length > 0) {
    process.stderr.write(
      `BLOCKED: shell edit of ${planTargets.join(', ')}. edit plan files with Write or Edit, so plan-lint sees them.\n`,
    );
    process.exit(2);
  }
  const targets = [
    ...new Set([...shellTargets(shellOnly, vars, sessionCwd), ...interpreterTargets(executed, vars, sessionCwd)]),
  ];
  if (targets.length === 0) {
    tierGate(input, shellCodeEdits(shellOnly, vars, sessionCwd));
    process.exit(0);
  }

  process.stderr.write(
    `BLOCKED: shell write to ${targets.join(', ')}. Use Write or Edit to create or change source, config and doc files — ` +
      'the Write|Edit hooks (comment check, util guard, implementer nudge, review lenses) never see a heredoc, redirect, ' +
      'tee, inline-script or copy-from-scratch write. sed -i one-liners, git mv, and output under /tmp or the scratchpad stay allowed, except on plan files.\n',
  );
  process.exit(2);
});
