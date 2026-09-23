#!/usr/bin/env bash
# $1 = PostToolUse (EnterPlanMode) | UserPromptSubmit (covers shift+tab entry via permission_mode). Once per session.
IN=$(cat)
EVENT="$1"
SID=$(jq -r '.session_id // empty' <<<"$IN")
MODE=$(jq -r '.permission_mode // empty' <<<"$IN")
[ "$EVENT" = "UserPromptSubmit" ] && [ "$MODE" != "plan" ] && exit 0
FLAG="/tmp/claude-plan-mode-${SID:-nosid}"
[ -e "$FLAG" ] && exit 0
touch "$FLAG"
if [ "$EVENT" = "PostToolUse" ]; then
  jq -Rs '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":.}}' "$HOME/.claude/plan-mode.md"
else
  cat "$HOME/.claude/plan-mode.md"
fi
