'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'enforce-subagent-model.sh');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-tier-hook-'));
const transcripts = {
  opus: path.join(tmpDir, 'opus.jsonl'),
  sonnet: path.join(tmpDir, 'sonnet.jsonl'),
  haiku: path.join(tmpDir, 'haiku.jsonl'),
};
fs.writeFileSync(transcripts.opus, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }));
fs.writeFileSync(transcripts.sonnet, JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5' } }));
fs.writeFileSync(transcripts.haiku, JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } }));
const UNREADABLE_TRANSCRIPT = '/nonexistent-transcript-path';

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function payload({ subagentType, model, prompt = 'x', transcriptPath, agentId }) {
  const tool_input = { subagent_type: subagentType, prompt };
  if (model !== undefined) tool_input.model = model;
  const obj = { tool_input, transcript_path: transcriptPath };
  if (agentId !== undefined) obj.agent_id = agentId;
  return obj;
}

function verdict(payloadObj) {
  const out = execFileSync('bash', [HOOK_PATH], { input: JSON.stringify(payloadObj), encoding: 'utf8' }).trim();
  if (out === '') return 'inherit';
  const parsed = JSON.parse(out);
  const decision = parsed.hookSpecificOutput.permissionDecision;
  if (decision === 'deny') return 'deny';
  if (decision === 'allow') return `inject:${parsed.hookSpecificOutput.updatedInput.model}`;
  throw new Error(`unexpected permissionDecision: ${decision}`);
}

test.describe('subagent tier hook', () => {
  test('code-reviewer, no model, sonnet session -> inject:opus', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.sonnet })),
      'inject:opus',
    );
  });

  test('Plan, no model, haiku session -> inject:opus', () => {
    assert.equal(verdict(payload({ subagentType: 'Plan', transcriptPath: transcripts.haiku })), 'inject:opus');
  });

  test('Plan, no model, opus session -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'Plan', transcriptPath: transcripts.opus })), 'inherit');
  });

  test('implementer, no model, sonnet session -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'implementer', transcriptPath: transcripts.sonnet })), 'inherit');
  });

  test('Explore, no model, opus session -> inject:haiku', () => {
    assert.equal(verdict(payload({ subagentType: 'Explore', transcriptPath: transcripts.opus })), 'inject:haiku');
  });

  test('Plan + model fable, unreadable transcript -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'Plan', model: 'fable', transcriptPath: UNREADABLE_TRANSCRIPT })),
      'deny',
    );
  });

  test('Plan + model fable, opus session -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'Plan', model: 'fable', transcriptPath: transcripts.opus })), 'inherit');
  });

  test('Plan + model fable, sonnet session -> deny', () => {
    assert.equal(verdict(payload({ subagentType: 'Plan', model: 'fable', transcriptPath: transcripts.sonnet })), 'deny');
  });

  test('explore-plan + model fable, opus session -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'explore-plan', model: 'fable', transcriptPath: transcripts.opus })),
      'deny',
    );
  });

  test('pr-review-toolkit:code-simplifier + model fable, opus session -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-simplifier', model: 'fable', transcriptPath: transcripts.opus })),
      'deny',
    );
  });

  test('Plan + model fable, opus session, agent_id set and tier-override prompt -> deny', () => {
    assert.equal(
      verdict(payload({
        subagentType: 'Plan',
        model: 'fable',
        transcriptPath: transcripts.opus,
        agentId: 'a1',
        prompt: '[tier-override: y]',
      })),
      'deny',
    );
  });

  test('implementer + model sonnet, opus session -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'implementer', model: 'sonnet', transcriptPath: transcripts.opus })),
      'inherit',
    );
  });

  test('checker + model haiku, opus session -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'checker', model: 'haiku', transcriptPath: transcripts.opus })),
      'inherit',
    );
  });

  test('implementer + model opus, sonnet session -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'implementer', model: 'opus', transcriptPath: transcripts.sonnet })),
      'deny',
    );
  });

  test('Plan + model opus, sonnet session -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'Plan', model: 'opus', transcriptPath: transcripts.sonnet })), 'inherit');
  });

  test('code-reviewer + model opus, haiku session -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'opus', transcriptPath: transcripts.haiku })),
      'inherit',
    );
  });

  test('Plan + model haiku, opus session -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'Plan', model: 'haiku', transcriptPath: transcripts.opus })),
      'deny',
    );
  });

  test('fork + model fable, sonnet session -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'fork', model: 'fable', transcriptPath: transcripts.sonnet })),
      'inherit',
    );
  });
});
