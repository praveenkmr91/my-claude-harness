#!/usr/bin/env bash
DOC="$1"
PATTERN="$2"
IN=$(cat)
SID=$(jq -r '.session_id // empty' <<<"$IN")
[ -z "$SID" ] && exit 0
AGENT_ID=$(jq -r '.agent_id // empty' <<<"$IN")
if [ -n "$PATTERN" ]; then
  jq -r '.tool_input.file_path // .tool_input.command // empty' <<<"$IN" | grep -qE "$PATTERN" || exit 0
fi

FLAG="/tmp/claude-inject-$DOC-$SID-${AGENT_ID:-main}"
( set -o noclobber; : > "$FLAG" ) 2>/dev/null || exit 0
jq -cn --arg c "[$DOC — injected once for this session; re-Read ~/.claude/$DOC if this scrolls out]
$(cat "$HOME/.claude/$DOC")" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
