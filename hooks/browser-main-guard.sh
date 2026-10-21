#!/bin/bash
# PreToolUse hook on mcp__chrome-devtools__.*: browser actions run off the main thread.
# Policy: ~/.claude/external-io.md. Escape: "[browser-inline: <why>]" in the last typed turn.
# A missing or unreadable transcript denies: the escape cannot be read.

input=$(cat)

echo "$input" | jq -e . >/dev/null 2>&1 || exit 0

tool_name=$(echo "$input" | jq -r '.tool_name // ""')
agent_id=$(echo "$input" | jq -r '.agent_id // ""')
transcript=$(echo "$input" | jq -r '.transcript_path // ""')

case "$tool_name" in
  mcp__chrome-devtools__*) ;;
  *) exit 0 ;;
esac
[ -n "$agent_id" ] && exit 0

case "${tool_name#mcp__chrome-devtools__}" in
  list_pages|select_page|take_snapshot|take_screenshot|list_console_messages|get_console_message|list_network_requests|get_network_request|get_css_styles|close_page) exit 0 ;;
esac

if [ -n "$transcript" ] && [ -r "$transcript" ]; then
  escaped=$(jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -rR -n 'include "turns";
        [inputs | fromjson? | typed_text] | last // "" | test("\\[browser-inline: \\S")' "$transcript" 2>/dev/null)
  [ "$escaped" = "true" ] && exit 0
fi

jq -n --arg reason 'Browser actions run off the main thread (~/.claude/external-io.md): dispatch browser-verifier for a verification, or fork for a debug that needs this context. Praveen lifts it for one turn by typing [browser-inline: <why>].' \
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
exit 0
