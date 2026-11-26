#!/usr/bin/env bash
# Agent PreToolUse hook, enforcing arm of ~/.claude/plan-build.md "The build carries the gates"; main thread only, subagents skipped.
#   Blocks an implementer dispatch in a plan build (this or an earlier implementer prompt since the last HANDOFF names an existing plan file) until this thread, since the last implementer hand-back,
#   ran a check (lint, type check, tests, or a checker dispatch) and a commit, or the dispatch prompt opens with `step gate: skip — <check|commit|step>: <why>`, one line per gate.
#   A dispatch still running and a denied dispatch never gate the next.
#   A check or commit counts only when its tool_result is not an error; nothing downstream re-checks a red run, so this hook does.
IN=$(exec cat)

[ -n "$(exec jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
SID=$(exec jq -r '.session_id // empty' <<<"$IN")
T=$(exec jq -r '.transcript_path // empty' <<<"$IN")
[ -n "$SID" ] && [ -r "$T" ] || exit 0
jq -e '.tool_input.subagent_type == "implementer"' <<<"$IN" >/dev/null || exit 0

# Quoted spans are blanked to underscores with the quotes kept, so `git -C "/p" commit` still matches and a commit message naming tsc is no check.
QUOTED='(?<q>'\''[^'\'']*'\''|"[^"\\]*(\\.[^"\\]*)*")'
# Twin of hooks/done-claim-gate.sh static_check (web lint and tsc only, case-insensitive); this one is a superset with test runners and mobile analyzers, case-sensitive. A change to the shared core goes in both; the extras never sync back.
CHECK='(^|[;&|(\n]\s*)((command|time|env(\s+\w+=\S*)*|if|then|!)\s+)?(\w+=\S*\s+)*((npm|pnpm|yarn|bun|npx|bunx)(\s+(run|exec|-{1,2}\w[\w-]*(=\S+)?(\s+(?!(?:run|exec)\s)[^\s;&|-]\S*)?))*\s+((nx|turbo|ng|playwright|biome|workspace\s+\S+)(\s+(run|exec|-{1,2}\w[\w-]*(=\S+)?(\s+(?!(?:run|exec)\s)[^\s;&|-]\S*)?))*\s+)?[\w:.-]*(lint|tsc|typecheck|type-check|check:types?|ts:check|check|verify|test|jest|vitest)[\w:.-]*|(\S*/)?(eslint|oxlint|tsc|vue-tsc|vitest|jest|svelte-check)(@\S+)?(?=\s|$|[;&|)])|node\s+--test\b|npm\s+t\b|make\s+(lint|test|check)\b|biome\s+check\b|deno\s+task\s+(lint|test|check)\b|(flutter|dart)\s+(analyze|test)\b|swiftlint\b|xcodebuild\b[^;&|\n]*\btest\b|(\S*/)?gradlew\s+([^;&|\n]*(\s|:))?(lint\w*|test\w*|ktlintCheck|detekt|\w+(Test|Lint))\b|swift\s+test\b)'
COMMIT='(^|[;&|(\n]\s*)((command|time|env(\s+\w+=\S*)*|if|then|!)\s+)?(\w+=\S*\s+)*git(\s+(-[Cc]\s+\S+|--?\w[\w-]*(=\S+)?))*\s+(commit(?!\s+(--dry-run|-h|--help)\b)|commit-tree|update-ref)\b'
NOOP='--(version|help|dry-run)\b'
SKIP='^\s*step gate: skip[[:space:]]*(—|–|-)+[[:space:]]*(check|commit|step|review):[[:space:]]*[^[:space:]<]'
PLAN_PATH='[^\s"'\''`]*/plans/[^/\s"'\''`]+\.md'
HANDOFF='<cross-session-message[^>]*>\s*\[HANDOFF '
# Gate names from the prompt's leading skip lines, one line per gate, so a dispatch missing both a check and a commit can skip both.
SKIPS_DEF='def skips: def lead: if length > 0 and (.[0] | test($skip)) then (.[0] | match($skip).captures[1].string), (.[1:] | lead) else empty end; split("\n") | map(select(test("\\S"))) | lead;'

# Parsed, not grepped: tool_result text, hand-back bodies and harness sessions quote `git commit` and `tsc`.
EVENTS=$(set -o pipefail; tail -c 20000000 "$T" 2>/dev/null | jq -L "$(exec dirname "${BASH_SOURCE[0]}")/lib" -rR --arg quoted "$QUOTED" --arg check "$CHECK" --arg commit "$COMMIT" --arg noop "$NOOP" --arg planpath "$PLAN_PATH" --arg handoff "$HANDOFF" 'include "turns"; fromjson? |
  (select(.type? == "user" and .origin.handback? == true and .origin.name? == "implementer") | "H"),
  (select(.type? == "attachment" and .attachment.origin.handback? == true and .attachment.origin.name? == "implementer") | "H"),
  (select(.type? == "user") | .message.content | strings | select(test($handoff)) | "O"),
  (select(.type? == "attachment") | .attachment.prompt? | strings | select(test($handoff)) | "O"),
  (select(.type? == "user") | .message.content[]? | select(.type? == "tool_result" and .is_error? == true) | "E \(.tool_use_id)"),
  (select(.type? == "assistant") | .message.content[]? | select(.type? == "tool_use") |
    if .name == "Agent" then (select(.input.subagent_type? == "checker") | "C \(.id)"),
      (select(.input.subagent_type? == "implementer") | .input.prompt? // "" | match($planpath; "g") | "P " + .string)
    elif .name == "Bash" then .id as $id | .input.command? // "" | gsub($quoted; .q[:1] + (.q[1:-1] | gsub("."; "_")) + .q[-1:])
      | select(test($noop) | not) | (select(test($check)) | "C \($id)"), (select(test($commit)) | "K \($id)")
    else empty end)' 2>/dev/null)
JQ_RC=$?
case $JQ_RC in 2|3) printf 'step-gate: jq failed (rc %s), gate not enforced\n' "$JQ_RC" >&2; exit 0 ;; esac

# The skip goes in the dispatch prompt: reply text from the same turn reaches the transcript only after PreToolUse has run.
PROMPT_EVENTS=$(exec jq -r --arg planpath "$PLAN_PATH" --arg skip "$SKIP" "$SKIPS_DEF"' .tool_input.prompt // "" | (match($planpath; "g") | "P " + .string), (skips | "S " + .)' <<<"$IN")

CWD=$(exec jq -r '.cwd // empty' <<<"$IN")

# A prompt that merely quotes a plans-dir path must not latch the build: `P <path>` becomes a bare `P` only when the file exists.
keep_existing_plans() {
  local line plan
  while IFS= read -r line; do
    if [[ $line != "P "* ]]; then printf '%s\n' "$line"; continue; fi
    plan=${line#P }
    # PLAN_PATH captures markdown or bracket decoration in front of the path (`**docs/plans/x.md**`).
    while [[ $plan == [\*\(\<]* ]]; do plan=${plan:1}; done
    case $plan in
      \~/*) plan=$HOME/${plan#\~/} ;;
      /*) ;;
      *) [ -n "$CWD" ] && plan=$CWD/$plan ;;
    esac
    [ -f "$plan" ] && echo P
  done
}

MISSING=$(printf '%s\n' "$EVENTS" "$PROMPT_EVENTS" \
  | keep_existing_plans \
  | awk '$0 == "H" { h = 1; c = sc = sk = ss = 0; delete cs; delete ks; delete es; next }
    $0 == "O" { p = 0; next }
    $0 == "P" { p = 1 } $1 == "C" && NF == 2 { cs[$2] = 1 } $1 == "K" { ks[$2] = 1 } $1 == "E" { es[$2] = 1 }
    $0 == "S check" { sc = 1 } $0 == "S commit" { sk = 1 } $0 == "S step" { ss = 1 }
    END {
      if (!p || !h || ss) exit
      for (id in cs) if (!(id in es)) c = 1
      for (id in ks) if (!(id in es)) k = 1
      check = c || sc; commit = k || sk
      if (!check && !commit) print "check or commit"; else if (!check) print "check"; else if (!commit) print "commit"
    }')

[ -n "$MISSING" ] || exit 0
printf 'The last `implementer` step handed back with no %s from this thread since. Per `plan-build.md` each step verifies, lints, type-checks and commits before the next dispatch. Run the step'\''s checks (or dispatch `checker`) and commit, or open the dispatch prompt with `step gate: skip — <check|commit>: <why>`, one line per gate (`commit: same-step fix` for a review fix before the commit; `step: <question answered>` when the hand-back was a question); reply text written this turn is not seen, and a plain retry stays blocked.\n' "$MISSING" >&2
exit 2
