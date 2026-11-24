#!/usr/bin/env node
// PostToolUse on Write|Edit of a plan file: refuses a step without a verify line, unparsed or unnamed structure, evidence sections and a second detailed chunk in a plan.
'use strict';

const fs = require('node:fs');

const PLAN_PATH = /(^|\/)plans\/[^/]+(?<!\.research)\.md$/;
const REPHRASE =
  'rephrase as an instruction or a decision; move facts, code reads, rejected alternatives, samples and dated material to <name>.research.md';
const NAME_CRITERIA = 'name each criterion in the step that delivers it';
const WRITE_PARSEABLE = 'write steps as `1. **`, `1.1 **`, `### 1.` or `## Step 1`, and criteria as `- A1` bullets';
const DRAFT_TITLE_ONLY = 'keep the draft chunk to its title, criteria and files; detail it once the previous chunk lands';
const ONE_DETAILED_CHUNK =
  'detail one chunk at a time: a landed chunk keeps its heading and one line naming the criteria it delivered; its steps and verify lines leave';
const OWN_HINT_RULES = ['P7', 'P8', 'P9', 'P11'];

const FENCE = /^\s*```/;
const MASKED_SPAN = /`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g;
const TABLE_ROW = /^\s*\|/;
const SECTION_HEADING = /^## /;
const EVIDENCE_HEADING = /^#{1,6}\s+(facts|blocked on)\b/i;
const REJECTED_LABEL = /Rejected:/;
const OPEN_HEADING = /^## Open(\s|$)/;
const STEP =
  /^(\d{1,2}(?:\.\d{1,2})+\.? \*\*|\d{1,2}\. \*\*|#{3,4} \d{1,2}(?:\.\d{1,2})+\.?(\s|$)|#{3,4} \d{1,2}\.(\s|$)|## (?:Step \d+\b|S\d+(?=\s*(?:[:.—–-]|$))))/;
const HEADING_STEP = /^## (?:Step \d+\b|S\d+(?=\s*(?:[:.—–-]|$)))/;
const STEPS_HEADING = /^## Steps\b/i;
const PLAIN_STEP = /^\d+\. /;
const TOP_LEVEL_BULLET = /^- /;
const DRAFT_HEADING = /^## .*\(draft\)/i;
const CHUNK_HEADING = /^## Chunk\b/i;
const BACKTICKED_SPAN = /`([^`\n]*)`/g;
const BARE_CITE = /[\w-]+\.[A-Za-z][A-Za-z0-9]*:\d+/;
const TICKED_CITE = /(?:\.[A-Za-z][A-Za-z0-9]*|^):\d+/;

const CRITERIA_HEADING = /^## (Criteria|Acceptance criteria|Acceptance)\s*$/i;
const CRITERION = /^- (?:\*\*|`)?([A-Z])(\d+)\b/;
const STEP_SECTION_HEADING = /^## (Step|Chunk|S\d)/i;
const UNPARSED_STEP_HEADING = /^## (Steps\s*$|Step \d+\b|Chunk \d+\b|S\d+(?=\s*(?:[:.—–-]|$)))/i;
const CRITERION_NAME = /\b([A-Z])(\d+)\b/g;
const CRITERION_RANGE = /\b([A-Z])(\d+)[–-]\1?(\d+)\b/g;

const OPEN_BULLET_LIMIT = 3;
const MAX_RANGE_SPAN = 99;

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

function evidenceLines(lines, masked) {
  return lines.flatMap((line, index) =>
    EVIDENCE_HEADING.test(line) || REJECTED_LABEL.test(masked[index])
      ? [{ line: index + 1, rule: 'P10', text: line.trim() }]
      : [],
  );
}

function sectionEnd(lines, start) {
  const nextSection = lines.findIndex((line, index) => index > start && SECTION_HEADING.test(line));
  return nextSection === -1 ? lines.length : nextSection;
}

function stepFlags(lines) {
  const flags = lines.map((line) => STEP.test(line));

  lines.forEach((heading, start) => {
    if (!HEADING_STEP.test(heading)) return;

    if (flags.slice(start + 1, sectionEnd(lines, start)).some(Boolean)) flags[start] = false;
  });

  lines.forEach((heading, start) => {
    if (!STEPS_HEADING.test(heading)) return;

    const end = sectionEnd(lines, start);
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

function hasLineCite(line) {
  if (BARE_CITE.test(line)) return true;
  return [...line.matchAll(BACKTICKED_SPAN)].some((span) => TICKED_CITE.test(span[1]));
}

function detailedDraftLines(lines) {
  const findings = [];

  lines.forEach((heading, start) => {
    if (!DRAFT_HEADING.test(heading)) return;

    const end = sectionEnd(lines, start);
    for (let index = start + 1; index < end; index++) {
      if (lines[index].includes('→ verify:') || hasLineCite(lines[index])) {
        findings.push({ line: index + 1, rule: 'P9', text: lines[index].trim() });
      }
    }
  });

  return findings;
}

function extraDetailedChunks(lines) {
  const detailed = lines.flatMap((heading, start) => {
    if (!CHUNK_HEADING.test(heading) || DRAFT_HEADING.test(heading)) return [];

    const body = lines.slice(start + 1, sectionEnd(lines, start));
    return body.some((line) => line.includes('→ verify:')) ? [{ line: start + 1, rule: 'P11', text: heading.trim() }] : [];
  });

  return detailed.slice(1);
}

function namedCriteria(line) {
  const single = [...line.matchAll(CRITERION_NAME)].map((match) => `${match[1]}${Number(match[2])}`);
  const ranged = [...line.matchAll(CRITERION_RANGE)].flatMap((match) => {
    const [from, to] = [Number(match[2]), Number(match[3])];
    if (to < from || to - from > MAX_RANGE_SPAN) return [];
    return Array.from({ length: to - from + 1 }, (_, offset) => `${match[1]}${from + offset}`);
  });

  return [...single, ...ranged];
}

function criteriaWithoutStep(lines) {
  const criteria = [];
  const named = new Set();
  let section = '';
  let hasStepSection = false;

  lines.forEach((line, index) => {
    if (SECTION_HEADING.test(line)) {
      section = '';
      if (CRITERIA_HEADING.test(line)) section = 'criteria';
      if (STEP_SECTION_HEADING.test(line)) {
        section = 'step';
        hasStepSection = true;
      }
    }

    if (section === 'step') namedCriteria(line).forEach((name) => named.add(name));

    const criterion = section === 'criteria' ? CRITERION.exec(line) : null;
    if (criterion) criteria.push({ line: index + 1, name: `${criterion[1]}${Number(criterion[2])}` });
  });

  if (!hasStepSection) return [];

  return criteria
    .filter(({ name }) => !named.has(name))
    .map(({ line, name }) => ({ line, rule: 'P7', text: `criterion ${name} has no step` }));
}

function hasCriterion(lines) {
  let inCriteria = false;

  return lines.some((line) => {
    if (SECTION_HEADING.test(line)) inCriteria = CRITERIA_HEADING.test(line);
    return inCriteria && CRITERION.test(line);
  });
}

function unparsedShapes(lines) {
  const findings = [];

  const criteriaHeading = lines.findIndex((line) => CRITERIA_HEADING.test(line));
  if (criteriaHeading !== -1 && !hasCriterion(lines)) {
    findings.push({ line: criteriaHeading + 1, rule: 'P8', text: 'no criteria parsed' });
  }

  const stepHeading = lines.findIndex((line) => UNPARSED_STEP_HEADING.test(line));
  if (stepHeading !== -1 && !stepFlags(lines).some(Boolean)) {
    findings.push({ line: stepHeading + 1, rule: 'P8', text: 'no steps parsed' });
  }

  return findings;
}

function lintPlan(text) {
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const masked = maskedLines(lines, fenced);
  const outsideFences = lines.map((line, index) => (fenced[index] ? '' : line));

  const findings = [
    ...unverifiedSteps(outsideFences),
    ...longOpenBullets(outsideFences),
    ...criteriaWithoutStep(outsideFences),
    ...unparsedShapes(outsideFences),
    ...detailedDraftLines(outsideFences),
    ...extraDetailedChunks(outsideFences),
    ...evidenceLines(outsideFences, masked),
  ];

  return findings.sort((a, b) => a.line - b.line);
}

const formatFindings = (findings) => findings.map((f) => `${f.line} ${f.rule} ${f.text}`).join('\n');

function hintLines(rules) {
  const hints = [];
  if (rules.includes('P7')) hints.push(NAME_CRITERIA);
  if (rules.includes('P8')) hints.push(WRITE_PARSEABLE);
  if (rules.includes('P9')) hints.push(DRAFT_TITLE_ONLY);
  if (rules.includes('P11')) hints.push(ONE_DETAILED_CHUNK);
  if (rules.some((rule) => !OWN_HINT_RULES.includes(rule))) hints.push(REPHRASE);
  return hints;
}

function runCheck(paths) {
  const entries = paths.flatMap((file) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [{ rule: 'unreadable', line: `${file}: unreadable` }];
    }
    return lintPlan(text).map((f) => ({ rule: f.rule, line: `${file}:${f.line} ${f.rule} ${f.text}` }));
  });

  if (entries.length === 0) process.exit(0);
  const report = [...entries.map((entry) => entry.line), ...hintLines(entries.map((entry) => entry.rule))];
  process.stderr.write(`${report.join('\n')}\n`);
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

    if (mode !== 'post') process.exit(0);

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      process.exit(0);
    }

    const findings = lintPlan(text);
    if (findings.length === 0) process.exit(0);

    const report = [formatFindings(findings), ...hintLines(findings.map((f) => f.rule))].join('\n');
    process.stderr.write(`${report}\n`);
    process.exit(2);
  });
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'check') runCheck(args);
else runHook(mode);
