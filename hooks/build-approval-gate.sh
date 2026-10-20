#!/usr/bin/env bash
# Write|Edit and Agent PreToolUse hook: after a plans/*.md edit, blocks source writes and `implementer` dispatches until a typed prompt says implement / build / start.
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

UNAPPROVED_PLAN=$(jq -nRr '
  def typed_prompt:
    select(.type? == "user" and (.isMeta | not) and (.isCompactSummary | not)) | .message.content
    | if type == "string" then . else ([.[]? | select(.type? == "text") | .text] | join(" ")) end
    | select(length > 0 and ((test("^\\s*<") | not) or test("^\\s*<pasted_content")));
  def approves: test("\\b(implement|build|start)\\b"; "i") and (test("\\b(didn[\u0027\u2019]?t|don[\u0027\u2019]?t|not|never|why)\\b"; "i") | not);
  reduce (inputs | fromjson?) as $e ({plan: null, approved: false};
    if $e.type? == "assistant" then
      ([$e.message.content[]? | select(.type? == "tool_use" and (.name == "Write" or .name == "Edit"))
        | .input.file_path // empty
        | select(test("/plans/[^/]+\\.md$") and (test("\\.research\\.md$") | not))] | last) as $edited
      | if $edited then {plan: $edited, approved: false} else . end
    elif .plan and ([$e | typed_prompt | select([split("\n")[] | select(approves)] | length > 0)] | length) > 0 then .approved = true
    else . end)
  | select(.plan and (.approved | not)) | .plan' "$T" 2>/dev/null)
[ -n "$UNAPPROVED_PLAN" ] || exit 0

printf 'The plan %s was edited and no typed implement / build / start has followed it. Answer the open items, then wait for that word before writing source or dispatching `implementer`; a later plan edit asks for it again.\n' "$UNAPPROVED_PLAN" >&2
exit 2
