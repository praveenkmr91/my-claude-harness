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
  fable: path.join(tmpDir, 'fable.jsonl'),
  fableAsked: path.join(tmpDir, 'fable-asked.jsonl'),
  fableAskedThenToolResult: path.join(tmpDir, 'fable-asked-tool-result.jsonl'),
};
const fableTurn = JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-1' } });
const askTurn = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'run a fable battery on this diff' }] } });
const toolResultTurn = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
fs.writeFileSync(transcripts.opus, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }));
fs.writeFileSync(transcripts.sonnet, JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5' } }));
fs.writeFileSync(transcripts.haiku, JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } }));
fs.writeFileSync(transcripts.fable, [JSON.stringify({ type: 'user', message: { content: 'review this' } }), fableTurn].join('\n'));
fs.writeFileSync(transcripts.fableAsked, [askTurn, fableTurn].join('\n'));
fs.writeFileSync(transcripts.fableAskedThenToolResult, [askTurn, fableTurn, toolResultTurn, fableTurn].join('\n'));
const proposalTurn = JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'HIGH risk and bulk, eight lenses on the separate pool. Fable battery?' }] } });
const mentionTurn = JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'The Fable pool is separate, so nothing changes here. Commit?' }] } });
const yesTurn = JSON.stringify({ type: 'user', message: { content: 'yes' } });
const noTurn = JSON.stringify({ type: 'user', message: { content: 'no, opus is fine' } });
const selfAttestTurn = JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'Dispatching the battery on Fable.' }] } });
transcripts.fableProposalApproved = path.join(tmpDir, 'fable-proposal-approved.jsonl');
transcripts.fableProposalDeclined = path.join(tmpDir, 'fable-proposal-declined.jsonl');
transcripts.fableSelfAttested = path.join(tmpDir, 'fable-self-attested.jsonl');
const userMentionTurn = JSON.stringify({ type: 'user', message: { content: 'Heads up: the new Fable-review gate opens on any yes after a reply that mentions Fable.' } });
transcripts.fableUserMention = path.join(tmpDir, 'fable-user-mention.jsonl');
fs.writeFileSync(transcripts.fableUserMention, [userMentionTurn, fableTurn].join('\n'));
const consultTurn = JSON.stringify({ type: 'user', message: { content: '/consult fable on the Label design' } });
transcripts.fableConsultAsk = path.join(tmpDir, 'fable-consult-ask.jsonl');
fs.writeFileSync(transcripts.fableConsultAsk, [consultTurn, fableTurn].join('\n'));
const opusTurn = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } });
const typedAsk = (text) => JSON.stringify({ type: 'user', message: { content: text } });
transcripts.opusReviewedByAsk = path.join(tmpDir, 'opus-reviewed-by-ask.jsonl');
transcripts.opusHaveFableReviewAsk = path.join(tmpDir, 'opus-have-fable-review-ask.jsonl');
transcripts.opusFableReviewedYesterday = path.join(tmpDir, 'opus-fable-reviewed-yesterday.jsonl');
fs.writeFileSync(transcripts.opusReviewedByAsk, [typedAsk('get it reviewed by fable'), opusTurn].join('\n'));
fs.writeFileSync(transcripts.opusHaveFableReviewAsk, [typedAsk('have fable review the diff'), opusTurn].join('\n'));
fs.writeFileSync(transcripts.opusFableReviewedYesterday, [typedAsk('fable reviewed it yesterday, looks fine'), opusTurn].join('\n'));
const summaryText = 'This session is being continued from a previous conversation. The user asked: run a fable battery on this diff';
transcripts.opusCompactSummaryAsk = path.join(tmpDir, 'opus-compact-summary-ask.jsonl');
transcripts.opusTypedSummaryAsk = path.join(tmpDir, 'opus-typed-summary-ask.jsonl');
fs.writeFileSync(transcripts.opusCompactSummaryAsk, [JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: summaryText } }), opusTurn].join('\n'));
fs.writeFileSync(transcripts.opusTypedSummaryAsk, [typedAsk(summaryText), opusTurn].join('\n'));
transcripts.fableMentionThenYes = path.join(tmpDir, 'fable-mention-then-yes.jsonl');
fs.writeFileSync(transcripts.fableMentionThenYes, [mentionTurn, yesTurn, fableTurn].join('\n'));
fs.writeFileSync(transcripts.fableProposalApproved, [proposalTurn, yesTurn, fableTurn].join('\n'));
fs.writeFileSync(transcripts.fableProposalDeclined, [proposalTurn, noTurn, fableTurn].join('\n'));
fs.writeFileSync(transcripts.fableSelfAttested, [fableTurn, yesTurn, selfAttestTurn].join('\n'));
const injectedTurn = JSON.stringify({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: '<system-reminder>lint passed</system-reminder>' }] } });
transcripts.fableApprovedThenInjection = path.join(tmpDir, 'fable-approved-then-injection.jsonl');
fs.writeFileSync(transcripts.fableApprovedThenInjection, [proposalTurn, yesTurn, fableTurn, injectedTurn, fableTurn].join('\n'));
transcripts.opusSonnetBatteryAsk = path.join(tmpDir, 'opus-sonnet-battery-ask.jsonl');
transcripts.opusSonnetBatteryAskReordered = path.join(tmpDir, 'opus-sonnet-battery-ask-reordered.jsonl');
transcripts.opusSonnetMissedBugs = path.join(tmpDir, 'opus-sonnet-missed-bugs.jsonl');
transcripts.opusSonnetBatteries = path.join(tmpDir, 'opus-sonnet-batteries.jsonl');
transcripts.opusSonnetAskThenThanks = path.join(tmpDir, 'opus-sonnet-ask-then-thanks.jsonl');
transcripts.fableBatteryOnFableAsk = path.join(tmpDir, 'fable-battery-on-fable-ask.jsonl');
transcripts.fableBatteryWasFine = path.join(tmpDir, 'fable-battery-was-fine.jsonl');
fs.writeFileSync(transcripts.opusSonnetBatteryAsk, [typedAsk('battery sonnet on this diff'), opusTurn].join('\n'));
fs.writeFileSync(transcripts.opusSonnetBatteryAskReordered, [typedAsk('run a sonnet battery'), opusTurn].join('\n'));
fs.writeFileSync(transcripts.opusSonnetMissedBugs, [typedAsk('sonnet missed bugs in the last battery'), opusTurn].join('\n'));
fs.writeFileSync(transcripts.opusSonnetBatteries, [typedAsk('sonnet batteries are cheap'), opusTurn].join('\n'));
fs.writeFileSync(transcripts.opusSonnetAskThenThanks, [typedAsk('battery sonnet on this diff'), opusTurn, typedAsk('ok thanks'), opusTurn].join('\n'));
fs.writeFileSync(transcripts.fableBatteryOnFableAsk, [typedAsk('battery on fable please'), fableTurn].join('\n'));
fs.writeFileSync(transcripts.fableBatteryWasFine, [typedAsk('the battery was fine'), fableTurn].join('\n'));
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

  test('cold-reader, no model, sonnet session -> inject:opus', () => {
    assert.equal(verdict(payload({ subagentType: 'cold-reader', transcriptPath: transcripts.sonnet })), 'inject:opus');
  });

  test('implementer, no model, sonnet session -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'implementer', transcriptPath: transcripts.sonnet })), 'inherit');
  });

  test('Explore, no model, opus session -> inject:haiku', () => {
    assert.equal(verdict(payload({ subagentType: 'Explore', transcriptPath: transcripts.opus })), 'inject:haiku');
  });

  test('code-reviewer, no model, fable session, no ask -> inject:opus', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fable })),
      'inject:opus',
    );
  });

  test('code-reviewer, no model, fable session, user asked for Fable -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableAsked })),
      'inherit',
    );
  });

  test('code-reviewer, no model, fable session, ask followed by tool_result turn -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableAskedThenToolResult })),
      'inherit',
    );
  });

  test('code-reviewer, no model, fable session, user approved a Fable proposal -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableProposalApproved })),
      'inherit',
    );
  });

  test('Plan + model fable, fable session, user typed "consult fable" -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'Plan', model: 'fable', transcriptPath: transcripts.fableConsultAsk })), 'inherit');
  });

  test('general-purpose + model fable, fable session, user typed "consult fable" -> deny (it can write)', () => {
    assert.equal(
      verdict(payload({ subagentType: 'general-purpose', model: 'fable', transcriptPath: transcripts.fableConsultAsk })),
      'deny',
    );
  });

  test('code-reviewer + model fable, opus session, user typed "get it reviewed by fable" -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'fable', transcriptPath: transcripts.opusReviewedByAsk })),
      'inherit',
    );
  });

  test('code-reviewer + model fable, opus session, user typed "have fable review the diff" -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'fable', transcriptPath: transcripts.opusHaveFableReviewAsk })),
      'inherit',
    );
  });

  test('code-reviewer + model fable, opus session, user typed "fable reviewed it yesterday" -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'fable', transcriptPath: transcripts.opusFableReviewedYesterday })),
      'deny',
    );
  });

  test('code-reviewer + model fable, opus session, "fable battery" only in a compaction summary -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'fable', transcriptPath: transcripts.opusCompactSummaryAsk })),
      'deny',
    );
  });

  test('code-reviewer + model fable, opus session, same "fable battery" text typed -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'fable', transcriptPath: transcripts.opusTypedSummaryAsk })),
      'inherit',
    );
  });

  test('general-purpose + model fable, opus session, user typed "get it reviewed by fable" -> deny (it can write)', () => {
    assert.equal(
      verdict(payload({ subagentType: 'general-purpose', model: 'fable', transcriptPath: transcripts.opusReviewedByAsk })),
      'deny',
    );
  });

  test('code-reviewer, no model, fable session, user turn only mentions Fable -> inject:opus', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableUserMention })),
      'inject:opus',
    );
  });

  test('code-reviewer, no model, fable session, "yes" after a reply that only mentions Fable -> inject:opus', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableMentionThenYes })),
      'inject:opus',
    );
  });

  test('code-reviewer, no model, fable session, user declined the Fable proposal -> inject:opus', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableProposalDeclined })),
      'inject:opus',
    );
  });

  test('code-reviewer, no model, fable session, approval followed by a hook-injected user turn -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableApprovedThenInjection })),
      'inherit',
    );
  });

  test('code-reviewer, no model, fable session, "yes" to no proposal and Fable named only in the current turn -> inject:opus', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', transcriptPath: transcripts.fableSelfAttested })),
      'inject:opus',
    );
  });

  test("implementer, no model, fable session, user asked for Fable -> inherit (the agent's declared model applies)", () => {
    assert.equal(verdict(payload({ subagentType: 'implementer', transcriptPath: transcripts.fableAsked })), 'inherit');
  });

  test("implementer, no model, fable session -> inherit (the agent's declared model applies)", () => {
    assert.equal(verdict(payload({ subagentType: 'implementer', transcriptPath: transcripts.fable })), 'inherit');
  });

  test("checker, no model, fable session -> inherit (the agent's declared model applies)", () => {
    assert.equal(verdict(payload({ subagentType: 'checker', transcriptPath: transcripts.fable })), 'inherit');
  });

  test('agent type with no definition file, no model, fable session -> inject:opus', () => {
    assert.equal(verdict(payload({ subagentType: 'no-such-agent', transcriptPath: transcripts.fable })), 'inject:opus');
  });

  test('general-purpose, no model, fable session -> inject:opus', () => {
    assert.equal(verdict(payload({ subagentType: 'general-purpose', transcriptPath: transcripts.fable })), 'inject:opus');
  });

  test('general-purpose, no model, opus session -> deny', () => {
    assert.equal(verdict(payload({ subagentType: 'general-purpose', transcriptPath: transcripts.opus })), 'deny');
  });

  test('general-purpose + model opus, opus session -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'general-purpose', model: 'opus', transcriptPath: transcripts.opus })),
      'inherit',
    );
  });

  test('general-purpose, no model, opus session, tier-override prompt -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'general-purpose', prompt: '[tier-override: y]', transcriptPath: transcripts.opus })),
      'inherit',
    );
  });

  test('general-purpose, no model, sonnet session -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'general-purpose', transcriptPath: transcripts.sonnet })), 'inherit');
  });

  test('no subagent_type, no model, opus session -> deny', () => {
    assert.equal(verdict(payload({ transcriptPath: transcripts.opus })), 'deny');
  });

  test('code-reviewer + model fable, opus session, user asked for Fable -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'fable', transcriptPath: transcripts.fableAsked })),
      'inherit',
    );
  });

  test('code-reviewer + model fable, fable session, no ask -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'fable', transcriptPath: transcripts.fable })),
      'deny',
    );
  });

  test('implementer + model fable, fable session, user asked for Fable -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'implementer', model: 'fable', transcriptPath: transcripts.fableAsked })),
      'deny',
    );
  });

  test('Plan + model fable, fable session -> inherit', () => {
    assert.equal(verdict(payload({ subagentType: 'Plan', model: 'fable', transcriptPath: transcripts.fable })), 'inherit');
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

  test('cold-reader + model sonnet, opus session -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'cold-reader', model: 'sonnet', transcriptPath: transcripts.opus })),
      'deny',
    );
  });

  test('fork + model fable, sonnet session -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'fork', model: 'fable', transcriptPath: transcripts.sonnet })),
      'inherit',
    );
  });

  test('reuse-analyzer + model sonnet, opus session, user typed "battery sonnet on this diff" -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'sonnet', transcriptPath: transcripts.opusSonnetBatteryAsk })),
      'inherit',
    );
  });

  test('code-reviewer + model sonnet, opus session, user typed "run a sonnet battery" -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'pr-review-toolkit:code-reviewer', model: 'sonnet', transcriptPath: transcripts.opusSonnetBatteryAskReordered })),
      'inherit',
    );
  });

  test('Plan + model sonnet, opus session, user typed "battery sonnet on this diff" -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'Plan', model: 'sonnet', transcriptPath: transcripts.opusSonnetBatteryAsk })),
      'deny',
    );
  });

  test('reuse-analyzer + model haiku, opus session, user typed "battery sonnet on this diff" -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'haiku', transcriptPath: transcripts.opusSonnetBatteryAsk })),
      'deny',
    );
  });

  test('reuse-analyzer + model sonnet, opus session, user typed "sonnet missed bugs in the last battery" -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'sonnet', transcriptPath: transcripts.opusSonnetMissedBugs })),
      'deny',
    );
  });

  test('reuse-analyzer + model sonnet, opus session, user typed "sonnet batteries are cheap" -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'sonnet', transcriptPath: transcripts.opusSonnetBatteries })),
      'deny',
    );
  });

  test('reuse-analyzer + model sonnet, opus session, Sonnet battery asked only in an earlier turn -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'sonnet', transcriptPath: transcripts.opusSonnetAskThenThanks })),
      'deny',
    );
  });

  test('reuse-analyzer + model sonnet, unreadable transcript -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'sonnet', transcriptPath: UNREADABLE_TRANSCRIPT })),
      'deny',
    );
  });

  test('reuse-analyzer + model fable, fable session, user typed "battery on fable please" -> inherit', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'fable', transcriptPath: transcripts.fableBatteryOnFableAsk })),
      'inherit',
    );
  });

  test('reuse-analyzer + model fable, fable session, user typed "the battery was fine" -> deny', () => {
    assert.equal(
      verdict(payload({ subagentType: 'reuse-analyzer', model: 'fable', transcriptPath: transcripts.fableBatteryWasFine })),
      'deny',
    );
  });
});
