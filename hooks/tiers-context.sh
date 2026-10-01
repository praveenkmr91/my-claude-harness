#!/usr/bin/env bash
SID=$(jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0

FLAG="/tmp/claude-tiers-ctx-$SID"
[ -e "$FLAG" ] && exit 0
touch "$FLAG"
jq -cn --arg c "[subagent-tiers.md — injected once for this session; re-Read ~/.claude/subagent-tiers.md if this scrolls out]
$(cat "$HOME/.claude/subagent-tiers.md")" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
