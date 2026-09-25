#!/usr/bin/env bash
# PostToolUse on Write|Edit. Advisory arm of ~/.claude/subagent-tiers.md: fires once per session,
# on the 6th distinct file written by an Opus-or-above main thread; subagents are skipped.
IN=$(cat)

[ -n "$(jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
F=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
[ -n "$SID" ] && [ -n "$F" ] && [ -r "$T" ] || exit 0

# Same oracle as enforce-subagent-model.sh: the live model, not settings.json.
MODEL=$(tail -c 200000 "$T" 2>/dev/null \
  | jq -rR 'fromjson? | select(.type? == "assistant") | .message.model // empty' 2>/dev/null | tail -1)
case "$MODEL" in *opus*|*fable*) ;; *) exit 0 ;; esac

FLAG="/tmp/claude-opus-write-nudge-$SID"
[ -e "$FLAG" ] && exit 0
SEEN="/tmp/claude-opus-write-files-$SID"
grep -qxF "$F" "$SEEN" 2>/dev/null || printf '%s\n' "$F" >>"$SEEN"
[ "$(wc -l <"$SEEN" | tr -d ' ')" -ge 6 ] || exit 0
touch "$FLAG"

printf 'This Opus thread has now written 6 files itself. Per "Model tier by work KIND" (~/.claude/CLAUDE.md), direct writes are fine, but remaining approved-plan steps (names, props and paths settled) or a bulk mechanical remainder are cheaper dispatched to `implementer`, one step per dispatch.\nIf that fits the remaining work, dispatch it; otherwise keep going without comment.\n' >&2
exit 2
