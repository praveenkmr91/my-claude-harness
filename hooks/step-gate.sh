#!/usr/bin/env bash
# Agent PreToolUse hook, enforcing arm of ~/.claude/plan-mode.md "The build carries the gates"; main thread only, subagents skipped.
#   Blocks an implementer dispatch whose prompt names a plan file until this thread, since the last implementer hand-back,
#   ran a check (lint, type check, tests, or a checker dispatch) and a commit, or stated `step gate: skip — <check|commit|step>: <why>`.
#   No hand-back yet → free: the first step, a dispatch still running and a denied dispatch never gate the next.
#   A check counts when it ran, not when it passed; done-claim-gate.sh catches a failed run at Stop.
IN=$(cat)

[ -n "$(jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
[ -n "$SID" ] && [ -r "$T" ] || exit 0
jq -e '.tool_input.subagent_type == "implementer" and (.tool_input.prompt // "" | test("/plans/[^/\\s]+\\.md"))' <<<"$IN" >/dev/null || exit 0

# Quoted spans are blanked to underscores with the quotes kept, so `git -C "/p" commit` still matches and a commit message naming tsc is no check.
QUOTED='(?<q>'\''[^'\'']*'\''|"[^"\\]*(\\.[^"\\]*)*")'
# Twin detector: hooks/done-claim-gate.sh static_check; keep the two in step.
CHECK='(^|[;&|(\n]\s*)(time\s+)?(\w+=\S*\s+)*((npm|pnpm|yarn|bun|npx|bunx)(\s+(run|exec|-{1,2}\w[\w-]*(=\S+)?(\s+(?!(?:run|exec)\s)[^\s;&|-]\S*)?))*\s+[\w:.-]*(lint|tsc|typecheck|type-check|check:types?|ts:check|verify|test|jest|vitest)[\w:.-]*|(\S*/)?(eslint|oxlint|tsc|vue-tsc|vitest|jest)(@\S+)?(?=\s|$|[;&|)])|node\s+--test\b)'
COMMIT='\bgit(\s+-C\s+\S+)?\s+(commit|commit-tree)\b|\bupdate-ref\b'
SKIP='step gate: skip[[:space:]]*(—|–|-)+[[:space:]]*(check|commit|step):[[:space:]]*[^[:space:]]'

# Parsed, not grepped: tool_result text, hand-back bodies and harness sessions quote `git commit` and `tsc`.
MISSING=$(tail -c 20000000 "$T" 2>/dev/null | jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -rR --arg quoted "$QUOTED" --arg check "$CHECK" --arg commit "$COMMIT" --arg skip "$SKIP" 'include "turns"; fromjson? |
  (select(.type? == "user" and .origin.handback? == true and .origin.name? == "implementer") | "H"),
  (select(.type? == "attachment" and .attachment.origin.handback? == true and .attachment.origin.name? == "implementer") | "H"),
  (select(.type? == "assistant") | .message.content[]? | select(.type? == "tool_use") |
    if .name == "Agent" then select(.input.subagent_type? == "checker") | "C"
    elif .name == "Bash" then .input.command? // "" | gsub($quoted; .q[:1] + (.q[1:-1] | gsub("."; "_")) + .q[-1:])
      | (select(test($check)) | "C"), (select(test($commit)) | "K")
    else empty end),
  (assistant_text | split("\n")[] | match($skip) | "S " + .captures[1].string)' 2>/dev/null \
  | awk '$0 == "H" { h = 1; c = k = sc = sk = ss = 0; next }
    $0 == "C" { c = 1 } $0 == "K" { k = 1 }
    $0 == "S check" { sc = 1 } $0 == "S commit" { sk = 1 } $0 == "S step" { ss = 1 }
    END {
      if (!h || ss) exit
      check = c || sc; commit = k || sk
      if (!check && !commit) print "check or commit"; else if (!check) print "check"; else if (!commit) print "commit"
    }')

[ -n "$MISSING" ] || exit 0
printf 'The last `implementer` step handed back with no %s from this thread since. Per `plan-mode.md` each step verifies, lints, type-checks and commits before the next dispatch. Run the step'\''s checks (or dispatch `checker`) and commit, or state `step gate: skip — <check|commit>: <why>` (`commit: same-step fix` for a review fix before the commit; `step: <question answered>` when the hand-back was a question); a plain retry stays blocked.\n' "$MISSING" >&2
exit 2
