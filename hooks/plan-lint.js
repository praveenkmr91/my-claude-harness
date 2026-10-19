#!/usr/bin/env node
// PreToolUse and PostToolUse on Write|Edit of a plan file: refuses research narrative in a plan.
'use strict';

const fs = require('node:fs');

const PLAN_PATH = /(^|\/)plans\/[^/]+(?<!\.research)\.md$/;
const REPHRASE =
  'rephrase as an instruction, a decision or a sourced fact row; move sampled, traced or dated material to <name>.research.md';

const FIRST_PERSON = /\bI\b/;
const JOURNAL_MARKER =
  /\b(we|found|turned out|turns out|investigated|investigation|probably|apparently|it seems|note that|interestingly|initially|originally|previously|at first)\b/i;

const FENCE = /^\s*```/;
const MASKED_SPAN = /`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g;
const TABLE_ROW = /^\s*\|/;
const HEADING = /^#{1,6}\s/;
const SECTION_HEADING = /^## /;
const RESEARCH_HEADING =
  /\b(sampled|traced|journey|findings?|research|investigation|log|notes|history|vs\.?|addendum|unverified)\b|\d{4}-\d{2}-\d{2}/i;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const CONTEXT_HEADING = /^## Context\s*$/;
const OPEN_HEADING = /^## Open\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;
const INDENTED = /^\s{2,}\S/;
const VERIFY_LINE = /^\s*→ verify/;
const STEP = /^(\d+\. \*\*|#{3,4} \d+\.)/;
const STEPS_HEADING = /^## Steps\b/i;
const PLAIN_STEP = /^\d+\. /;
const TOP_LEVEL_BULLET = /^- /;

const PARAGRAPH_LIMIT = 200;
const CONTEXT_PARAGRAPH_LIMIT = 500;
const OPEN_BULLET_LIMIT = 3;

function fencedLines(lines) {
  let inFence = false;
  return lines.map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return true;
    }
    return inFence;
  });
}

const spaces = (text) => ' '.repeat(text.length);

function maskedLines(lines, fenced) {
  let sourceColumn = -1;
  let previousWasRow = false;

  return lines.map((line, index) => {
    if (fenced[index]) {
      previousWasRow = false;
      return spaces(line);
    }

    const masked = line.replace(MASKED_SPAN, spaces);
    if (!TABLE_ROW.test(masked)) {
      previousWasRow = false;
      return masked;
    }

    const cells = masked.split('|');
    if (!previousWasRow) sourceColumn = cells.findIndex((cell) => cell.trim() === 'Source');
    previousWasRow = true;

    return cells.map((cell, column) => (column === sourceColumn ? spaces(cell) : cell)).join('|');
  });
}

function journalFindings(lines, masked) {
  return lines.flatMap((line, index) => {
    const text = masked[index];
    return FIRST_PERSON.test(text) || JOURNAL_MARKER.test(text)
      ? [{ line: index + 1, rule: 'P1', text: line.trim() }]
      : [];
  });
}

function researchHeadings(lines, masked) {
  return lines.flatMap((line, index) =>
    SECTION_HEADING.test(line) && RESEARCH_HEADING.test(masked[index])
      ? [{ line: index + 1, rule: 'P5', text: line.trim() }]
      : [],
  );
}

function datedLines(lines, masked) {
  return lines.flatMap((line, index) =>
    !SECTION_HEADING.test(line) && DATE.test(masked[index])
      ? [{ line: index + 1, rule: 'P6', text: line.trim() }]
      : [],
  );
}

const isProse = (line) =>
  line.trim() !== '' &&
  !HEADING.test(line) &&
  !LIST_ITEM.test(line) &&
  !INDENTED.test(line) &&
  !TABLE_ROW.test(line) &&
  !VERIFY_LINE.test(line);

function longParagraphs(lines) {
  const findings = [];
  let inContext = false;
  let runStart = 0;
  let run = [];

  [...lines, ''].forEach((line, index) => {
    if (isProse(line)) {
      if (run.length === 0) runStart = index;
      run.push(line.trim());
      return;
    }

    const limit = inContext ? CONTEXT_PARAGRAPH_LIMIT : PARAGRAPH_LIMIT;
    if (run.join(' ').length > limit) {
      findings.push({ line: runStart + 1, rule: 'P2', text: run[0] });
    }
    run = [];

    if (SECTION_HEADING.test(line)) inContext = CONTEXT_HEADING.test(line);
  });

  return findings;
}

function stepFlags(lines) {
  const flags = lines.map((line) => STEP.test(line));

  lines.forEach((heading, start) => {
    if (!STEPS_HEADING.test(heading)) return;

    const nextSection = lines.findIndex((line, index) => index > start && SECTION_HEADING.test(line));
    const end = nextSection === -1 ? lines.length : nextSection;
    if (flags.slice(start, end).some(Boolean)) return;

    for (let index = start + 1; index < end; index++) flags[index] = PLAIN_STEP.test(lines[index]);
  });

  return flags;
}

function unverifiedSteps(lines) {
  const isStep = stepFlags(lines);

  return lines.flatMap((line, index) => {
    if (!isStep[index]) return [];

    const stepEnd = lines.findIndex(
      (candidate, next) => next > index && (isStep[next] || SECTION_HEADING.test(candidate)),
    );
    const step = lines.slice(index, stepEnd === -1 ? undefined : stepEnd);

    return step.join(' ').replace(/\s+/g, ' ').includes('→ verify:')
      ? []
      : [{ line: index + 1, rule: 'P3', text: line.trim() }];
  });
}

function bulletLineCount(lines, start) {
  let last = start;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (TOP_LEVEL_BULLET.test(line) || SECTION_HEADING.test(line)) break;

    if (line.trim() === '') {
      const following = lines.slice(index + 1).find((next) => next.trim() !== '');
      if (following === undefined || !/^\s/.test(following)) break;
      continue;
    }

    last = index;
  }

  return last - start + 1;
}

function longOpenBullets(lines) {
  const findings = [];
  let inOpen = false;

  lines.forEach((line, index) => {
    if (SECTION_HEADING.test(line)) inOpen = OPEN_HEADING.test(line);
    if (!inOpen || !TOP_LEVEL_BULLET.test(line)) return;

    if (bulletLineCount(lines, index) > OPEN_BULLET_LIMIT) {
      findings.push({ line: index + 1, rule: 'P4', text: line.trim() });
    }
  });

  return findings;
}

function lintPlan(text, { fragment }) {
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const masked = maskedLines(lines, fenced);
  const findings = journalFindings(lines, masked);

  if (!fragment) {
    const outsideFences = lines.map((line, index) => (fenced[index] ? '' : line));
    findings.push(
      ...longParagraphs(outsideFences),
      ...unverifiedSteps(outsideFences),
      ...longOpenBullets(outsideFences),
      ...researchHeadings(outsideFences, masked),
      ...datedLines(outsideFences, masked),
    );
  }

  return findings.sort((a, b) => a.line - b.line);
}

const formatFindings = (findings) => findings.map((f) => `${f.line} ${f.rule} ${f.text}`).join('\n');

function runCheck(paths) {
  const report = paths.flatMap((file) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [`${file}: unreadable`];
    }
    return lintPlan(text, { fragment: false }).map((f) => `${file}:${f.line} ${f.rule} ${f.text}`);
  });

  if (report.length === 0) process.exit(0);
  process.stderr.write(`${report.join('\n')}\n${REPHRASE}\n`);
  process.exit(1);
}

function runHook(mode) {
  let raw = '';
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      process.exit(0);
    }
    const file = input.tool_input?.file_path;
    if (typeof file !== 'string' || !PLAN_PATH.test(file)) process.exit(0);

    let text;
    if (mode === 'pre') {
      text = input.tool_input.content ?? input.tool_input.new_string;
      if (typeof text !== 'string') process.exit(0);
    } else if (mode === 'post') {
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        process.exit(0);
      }
    } else {
      process.exit(0);
    }

    const findings = lintPlan(text, { fragment: mode === 'pre' }).filter((f) => mode === 'post' || f.rule === 'P1');
    if (findings.length === 0) process.exit(0);

    const report = `${formatFindings(findings)}\n${REPHRASE}`;
    if (mode === 'post') {
      process.stderr.write(`${report}\n`);
      process.exit(2);
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: report },
      }),
    );
    process.exit(0);
  });
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'check') runCheck(args);
else runHook(mode);
