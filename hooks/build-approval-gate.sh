#!/usr/bin/env bash
# Write|Edit and Agent PreToolUse hook: after a plans/*.md edit, blocks source writes and `implementer` dispatches until a typed prompt says implement / build / start.
# Approval = a clause that opens with the word ("implement", "yes, build it", "review plan and implement"), outside a question, with no not / don't / why / later / yet / until in that clause.
# Third-person or descriptive mentions ("new session will implement", "start app", "only start is deployed") and a prompt that defers ("ask for my approval") never approve.
# Fails open (exit 0) on a subagent call, an unreadable transcript, no plan edit in the transcript, or an ungated target.
IN=$(cat)

[ -n "$(jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
F=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
[ -r "$T" ] || exit 0

if [ -n "$F" ]; then
  grep -qE '\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py|csv)$|(^|/)package\.json$' <<<"$F" || exit 0
else
  [ "$(jq -r '.tool_input.subagent_type // empty' <<<"$IN")" = implementer ] || exit 0
fi

UNAPPROVED_PLAN=$(jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -nRr 'include "turns";
  def approving_clause:
    test("^\\s*(?:(?:yes|ok|okay|approved|sure|go ahead and|go ahead|now|so|please|pls|proceed to|let[\u0027\u2019]?s)\\b[\\s,.!-]*)*(?:implement|build|start(?=\\s*$|\\s+(?:impl\\w*|building|coding|now|it\\b|step|chunk|\\d)))\\b"; "i")
    and (test("\\b(?:didn|don|doesn|won|isn|shouldn)[\u0027\u2019]?t\\b|\\b(?:not|never|why|later|yet|until)\\b"; "i") | not);
  def approves:
    (test("\\b(?:ask (?:for )?my approval|until i approve|wait for my (?:approval|go|ok|yes))\\b"; "i") | not)
    and ([splits("\n|(?<=[.!?;])\\s+") | select(test("\\?\\s*$") | not) | splits("[,:]|\\s+(?:and|then)\\s+"; "i") | select(approving_clause)] | length > 0);
  reduce (inputs | fromjson?) as $e ({plan: null, approved: false};
    if $e.type? == "assistant" then
      ([$e.message.content[]? | select(.type? == "tool_use" and (.name == "Write" or .name == "Edit"))
        | .input.file_path // empty
        | select(test("/plans/[^/]+\\.md$") and (test("\\.research\\.md$") | not))] | last) as $edited
      | if $edited then {plan: $edited, approved: false} else . end
    elif .plan and ([$e | typed_text | select(approves)] | length) > 0 then .approved = true
    else . end)
  | select(.plan and (.approved | not)) | .plan' "$T" 2>/dev/null)
[ -n "$UNAPPROVED_PLAN" ] || exit 0

printf 'The plan %s was edited and no typed implement / build / start has followed it. The word has to open an instruction (`implement`, `yes, implement chunk 2`); a question, a deferral (not / later / until I approve) or a mention of someone else building does not count. Answer the open items, then wait for that word before writing source or dispatching `implementer`; a later plan edit asks for it again.\n' "$UNAPPROVED_PLAN" >&2
exit 2
