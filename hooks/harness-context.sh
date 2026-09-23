#!/usr/bin/env bash
IN=$(cat)
SID=$(jq -r '.session_id // empty' <<<"$IN")
[ -z "$SID" ] && exit 0
DOC="$HOME/.claude/harness.md"
TOOL=$(jq -r '.tool_name // empty' <<<"$IN")
FILE=$(jq -r '.tool_input.file_path // empty' <<<"$IN")

case "$TOOL" in
  mcp__claude_ai_Figma__download_assets) KEY=figma; SEC='## Figma MCP' ;;
  Bash)
    CMD=$(jq -r '.tool_input.command // empty' <<<"$IN")
    CMD=$(sed -E 's#(~|\$HOME|'"$HOME"')/\.claude/(projects|plans)/##g' <<<"$CMD")
    case "$CMD" in *'~/.claude'*|*'$HOME/.claude'*|*"$HOME/.claude"*) ;; *) exit 0 ;; esac
    grep -qE 'sed -i|tee |>|python3|node --test|git -C|--accept|\b(cp|mv|rm) ' <<<"$CMD" || exit 0
    KEY=maint; SEC='## Maintenance' ;;
  Write|Edit)
    case "$FILE" in
      "$HOME/.claude/projects/"*|"$HOME/.claude/plans/"*) exit 0 ;;
      "$HOME/.claude/"*|*/CLAUDE.md|*/CLAUDE.local.md|*/.claude/*) KEY=maint; SEC='## Maintenance' ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac

FLAG="/tmp/claude-harness-ctx-$SID-$KEY"
[ -e "$FLAG" ] && exit 0
touch "$FLAG"
BODY=$(awk -v h="$SEC" '/^## /{p=index($0,h)==1} p' "$DOC")
[ -z "$BODY" ] && exit 0
jq -cn --arg c "[harness.md — injected once for this session; re-Read ~/.claude/harness.md if this scrolls out]
$BODY" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
