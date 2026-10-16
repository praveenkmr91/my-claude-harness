#!/usr/bin/env bash
# $1 = PostToolUse (EnterPlanMode) | UserPromptSubmit (covers shift+tab entry via permission_mode)
#    | PreToolUse (Write/Edit of a plan file — plan drift is edited outside plan mode). Once per session.
IN=$(cat)
EVENT="$1"
SID=$(jq -r '.session_id // empty' <<<"$IN")
MODE=$(jq -r '.permission_mode // empty' <<<"$IN")
[ "$EVENT" = "UserPromptSubmit" ] && [ "$MODE" != "plan" ] && exit 0
if [ "$EVENT" = "PreToolUse" ]; then
  FILE=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
  case "$FILE" in *.research.md) exit 0 ;; esac
  case "$FILE" in "$HOME/.claude/plans/"*.md|*/docs/plans/*.md) ;; *) exit 0 ;; esac
fi
FLAG="/tmp/claude-plan-mode-${SID:-nosid}"
[ -e "$FLAG" ] && exit 0
touch "$FLAG"
if [ "$EVENT" != "UserPromptSubmit" ]; then
  jq -Rs --arg e "$EVENT" '{"hookSpecificOutput":{"hookEventName":$e,"additionalContext":.}}' "$HOME/.claude/plan-mode.md"
else
  cat "$HOME/.claude/plan-mode.md"
fi
