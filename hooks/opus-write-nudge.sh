#!/usr/bin/env bash
# Write|Edit hook, advisory arm of ~/.claude/subagent-tiers.md; Opus-or-above main thread only, subagents skipped.
#   pre  (PreToolUse): once per session, blocks the next source write after a typed prompt pairs implement/execute
#        (incl. -s/-ed) with a plans/*.md path, unless implementer was dispatched; the tier call comes before file one, not file six.
#   post (PostToolUse, default): fires on the 6th distinct source file written, and again on the 15th unless
#        implementer was dispatched.
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
VERDICT='State the call in your next reply as `implementer: dispatching` or `implementer: skip — <reason>`.'

if [ "$MODE" = pre ]; then
  FLAG="/tmp/claude-opus-write-nudge-$SID-plan"
  [ -e "$FLAG" ] && exit 0
  # Typed prompts only: tool_result blocks, isMeta records and `<`-prefixed harness wrappers (except pasted blocks) quote plan paths too.
  # No \b in the raw prefilter: JSONL stores a newline as `\n`, so "\nImplement" has no word boundary.
  PLAN=$(grep -iE 'implement|execute' "$T" | grep -E 'plans/' \
    | jq -rR 'fromjson? | select(.type? == "user" and (.isMeta | not)) | .message.content
        | if type == "string" then . else ([.[]? | select(.type? == "text") | .text] | join(" ")) end
        | select((test("^\\s*<") | not) or test("^\\s*<pasted_content"))
        | gsub("\n"; " ")' 2>/dev/null \
    | grep -iE '\b(implement|execute)(s|ed)?\b' | grep -oE '[^[:space:]`"]*plans/[^[:space:]`"]+\.md' | head -1)
  [ -n "$PLAN" ] || exit 0
  touch "$FLAG"
  [ -n "$(dispatched)" ] && exit 0
  printf 'This session executes an approved plan (%s). Per "Model tier by work KIND" (~/.claude/CLAUDE.md), its settled steps go to `implementer`, one step per dispatch; this thread writes source only for a step whose design call the plan leaves open. This write is blocked once; a retry passes.\n%s\n' "$PLAN" "$VERDICT" >&2
  exit 2
fi

SEEN="/tmp/claude-opus-write-files-$SID"
grep -qxF "$F" "$SEEN" 2>/dev/null || printf '%s\n' "$F" >>"$SEEN"
N=$(wc -l <"$SEEN" | tr -d ' ')
if [ "$N" -ge 15 ]; then STAGE=15; elif [ "$N" -ge 6 ]; then STAGE=6; else exit 0; fi
FLAG="/tmp/claude-opus-write-nudge-$SID-$STAGE"
[ -e "$FLAG" ] && exit 0
touch "$FLAG"

if [ "$STAGE" = 15 ]; then
  [ -n "$(dispatched)" ] && exit 0
  printf 'This Opus thread has now written 15 files itself with no `implementer` dispatch this session. Re-check the remainder against "Model tier by work KIND" (~/.claude/CLAUDE.md): approved-plan steps or a bulk mechanical remainder go to `implementer`, one step per dispatch.\n%s\n' "$VERDICT" >&2
else
  printf 'This Opus thread has now written 6 files itself. Per "Model tier by work KIND" (~/.claude/CLAUDE.md), direct writes are fine, but remaining approved-plan steps (names, props and paths settled) or a bulk mechanical remainder are cheaper dispatched to `implementer`, one step per dispatch.\n%s\n' "$VERDICT" >&2
fi
exit 2
