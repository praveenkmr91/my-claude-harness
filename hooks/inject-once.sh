#!/usr/bin/env bash
DOC="$1"
PATH_PATTERN="$2"
IN=$(cat)
SID=$(jq -r '.session_id // empty' <<<"$IN")
[ -z "$SID" ] && exit 0
AGENT_ID=$(jq -r '.agent_id // empty' <<<"$IN")
if [ -n "$PATH_PATTERN" ]; then
  jq -r '.tool_input.file_path // empty' <<<"$IN" | grep -qE "$PATH_PATTERN" || exit 0
fi

FLAG="/tmp/claude-inject-$DOC-$SID-${AGENT_ID:-main}"
[ -e "$FLAG" ] && exit 0
touch "$FLAG"
jq -cn --arg c "[$DOC — injected once for this session; re-Read ~/.claude/$DOC if this scrolls out]
$(cat "$HOME/.claude/$DOC")" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
