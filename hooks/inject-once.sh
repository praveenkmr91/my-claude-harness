#!/usr/bin/env bash
DOC="$1"
PATTERN="$2"
SUBAGENT_EXEMPT="$3"
IN=$(exec cat)
SID=$(exec jq -r '.session_id // empty' <<<"$IN")
[ -z "$SID" ] && exit 0
AGENT_ID=$(exec jq -r '.agent_id // empty' <<<"$IN")
if [ -n "$PATTERN" ]; then
  TARGET=$(exec jq -r '.tool_input.file_path // .tool_input.command // .tool_input.subagent_type // empty' <<<"$IN")
  # Exempt text is stripped, never allowlisted: a command the exempt pattern does not recognise still injects.
  if [ -n "$AGENT_ID" ] && [ -n "$SUBAGENT_EXEMPT" ]; then
    TARGET=$(exec sed -E -e ':a' -e "s"$'\001'"$SUBAGENT_EXEMPT"$'\001'" "$'\001' -e 'ta' <<<"$TARGET")
  fi
  grep -qE "$PATTERN" <<<"$TARGET" || exit 0
fi

FLAG="/tmp/claude-inject-$DOC-$SID-${AGENT_ID:-main}"
( set -o noclobber; : > "$FLAG" ) 2>/dev/null || exit 0
jq -cn --arg c "[$DOC — injected once for this session; re-Read ~/.claude/$DOC if this scrolls out]
$(exec cat "$HOME/.claude/$DOC")" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
