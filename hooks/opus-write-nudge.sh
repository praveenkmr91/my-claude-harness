#!/usr/bin/env bash
# Write|Edit hook, advisory arm of ~/.claude/subagent-tiers.md; Opus-or-above main thread only, subagents skipped.
#   pre  (PreToolUse): from a Fable session, blocks every source write outright — Fable never writes code unless the last typed prompt carries [tier-override: <why>].
#        From Opus, after a typed prompt pairs implement/execute (incl. -s/-ed) with a plans/*.md path, blocks every
#        source write until implementer was dispatched or this turn states `implementer: skip — open call: <item>`.
#        No retry pass: a one-shot block let "small" / "in context" skips through (2026-10-11).
#   post (PostToolUse, default): from the 6th distinct source file on, fires on every new one until implementer was
#        dispatched or this turn states an open-call skip. A one-shot nudge let an "urgent hotfix" skip through (2026-10-19).
IN=$(cat)
MODE=${1:-post}

[ -n "$(jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
F=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
[ -n "$SID" ] && [ -n "$F" ] && [ -r "$T" ] || exit 0
grep -qE '\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)$' <<<"$F" || exit 0

# Same oracle as enforce-subagent-model.sh: the live model, not settings.json.
MODEL=$(tail -c 200000 "$T" 2>/dev/null \
  | jq -rR 'fromjson? | select(.type? == "assistant") | .message.model // empty' 2>/dev/null | tail -1)
case "$MODEL" in *opus*|*fable*) ;; *) exit 0 ;; esac

# Parsed, not grepped: harness sessions quote "subagent_type":"implementer" in Bash output.
dispatched() {
  jq -rR 'fromjson? | select(.type? == "assistant") | .message.content[]?
    | select(.type? == "tool_use" and .input.subagent_type? == "implementer") | .id' "$T" 2>/dev/null | head -1
}

# Assistant text since the last typed prompt names an open plan call; a generic reason does not match.
skipped() {
  jq -rR 'fromjson? |
    if .type? == "user" and (.isMeta | not) then
      (.message.content | if type == "string" then . else ([.[]? | select(.type? == "text") | .text] | join(" ")) end)
      | select(length > 0 and ((test("^\\s*<") | not) or test("^\\s*<pasted_content")))
      | "U"
    elif .type? == "assistant" then
      .message.content[]? | select(.type? == "text") | "A " + (.text | gsub("\n"; " "))
    else empty end' "$T" 2>/dev/null \
    | awk '$0 == "U" { buf = ""; next } { buf = buf "\n" $0 } END { print buf }' \
    | grep -qE 'implementer: skip[[:space:]]*(—|–|-)+[[:space:]]*open call:[[:space:]]*[^[:space:]]'
}

# Typed prompts only: tool_result blocks, isMeta records, compaction summaries and `<`-prefixed harness wrappers (except pasted blocks) quote plan paths and override tags too.
typed_prompts() {
  jq -rR 'fromjson? | select(.type? == "user" and (.isMeta | not) and (.isCompactSummary | not)) | .message.content
    | if type == "string" then . else ([.[]? | select(.type? == "text") | .text] | join(" ")) end
    | select(length > 0 and ((test("^\\s*<") | not) or test("^\\s*<pasted_content")))
    | gsub("\n"; " ")' 2>/dev/null
}

# Last typed prompt carries [tier-override: <why>] — the same escape enforce-subagent-model.sh takes; a new typed prompt without it re-arms.
overridden() {
  typed_prompts <"$T" | tail -1 | grep -q '\[tier-override:'
}

if [ "$MODE" = pre ]; then
  case "$MODEL" in *fable*)
    overridden && exit 0
    printf 'This thread runs Fable, and Fable never writes code (~/.claude/subagent-tiers.md). Dispatch `implementer` with the exact edit (file, old text, new text, acceptance check); docs, config and plan files stay direct. No skip line lifts this and a retry stays blocked; a typed prompt carrying `[tier-override: <why>]` lifts it for that turn.\n' >&2
    exit 2 ;;
  esac
  # No \b in the raw prefilter: JSONL stores a newline as `\n`, so "\nImplement" has no word boundary.
  PLAN=$(grep -iE 'implement|execute' "$T" | grep -E 'plans/' | typed_prompts \
    | grep -iE '\b(implement|execute)(s|ed)?\b' | grep -oE '[^[:space:]`"]*plans/[^[:space:]`"]+\.md' | head -1)
  [ -n "$PLAN" ] || exit 0
  [ -n "$(dispatched)" ] && exit 0
  skipped && exit 0
  printf 'This session executes an approved plan (%s). Per "Model tier by work KIND" (~/.claude/CLAUDE.md), its settled steps go to `implementer`, one step per dispatch. Source writes on this thread stay blocked until `implementer` is dispatched, or this turn states `implementer: skip — open call: <the item the plan leaves open>`. Size and already-loaded context are not open calls; a plain retry stays blocked.\n' "$PLAN" >&2
  exit 2
fi

SEEN="/tmp/claude-opus-write-files-$SID"
grep -qxF "$F" "$SEEN" 2>/dev/null && exit 0
printf '%s\n' "$F" >>"$SEEN"
N=$(wc -l <"$SEEN" | tr -d ' ')
[ "$N" -ge 6 ] || exit 0
[ -n "$(dispatched)" ] && exit 0
skipped && exit 0

printf 'This Opus thread has now written %s source files itself with no `implementer` dispatch. Per ~/.claude/subagent-tiers.md, a settled fix (an approved plan step, or a direct ask whose result is fixed) goes to `implementer`, one step per dispatch. Dispatch it, or state `implementer: skip — open call: <the design call still undecided>`; urgency, size and already-loaded context are not open calls. This repeats on every new source file until one of the two happens.\n' "$N" >&2
exit 2
