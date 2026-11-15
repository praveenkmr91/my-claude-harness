'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('correction-learn: fires on repeated corrections, silent on ordinary prompts', () => {
  const hook = path.join(ROOT, 'hooks', 'correction-learn.sh');
  const fires = (prompt) => execFileSync('bash', [hook], { input: JSON.stringify({ prompt }), encoding: 'utf8' }).includes('<correction-learn>');
  // Prompts copied from session transcripts (2026-09-13..25 census).
  for (const p of [
    'i told u many times. make the components flexible regarless of callers yet.',
    'why do u keep missing ? all figma calls must go through tooling/',
    'i didnt approve plan. i only told u to review. whats wrong with u',
    'waht the heck. i said its ok not to be parllel. use sonnet stupid',
    'how many times do i have to tell u not to be too verbose',
  ]) assert.ok(fires(p), p);
  for (const p of [
    'approved again',
    'why do u need seperate branch?',
    'as i said, now we have liberty/ freedom/ power to decide on architecture.',
    'meeting ended. lets find answers on our own instead of rushing to asking stupid questions',
    '<task-notification>i told you</task-notification>',
    '<agent-message from="a1">\n[Subagent hand-back] The report follows:\n  "i didnt approve plans. why are u implementing already?"\n</agent-message>',
  ]) assert.ok(!fires(p), p);
});
