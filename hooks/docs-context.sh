#!/usr/bin/env bash
IN=$(cat)
SID=$(jq -r '.session_id // empty' <<<"$IN")
[ -z "$SID" ] && exit 0

case "$(jq -r '.tool_name // empty' <<<"$IN")" in
  Write|Edit)
    jq -r '.tool_input.content // .tool_input.new_string // empty' <<<"$IN" | grep -qE "from ['\"][^./'\"]" || exit 0 ;;
  WebFetch)
    case "$(jq -r '.tool_input.url // empty' <<<"$IN")" in
      *://github.com/*|*://raw.githubusercontent.com/*) exit 0 ;;
    esac ;;
  WebSearch|mcp__plugin_context7_context7__*) ;;
  *) exit 0 ;;
esac

FLAG="/tmp/claude-docs-ctx-$SID"
[ -e "$FLAG" ] && exit 0
touch "$FLAG"
jq -cn --arg c "[library-docs.md — injected once for this session; re-Read ~/.claude/library-docs.md if this scrolls out]
$(cat "$HOME/.claude/library-docs.md")" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
