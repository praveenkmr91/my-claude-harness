#!/bin/bash
FILE=$(jq -r '.tool_input.file_path // ""')
[[ ! "$FILE" =~ \.(js|jsx|ts|tsx|mjs|cjs)$ ]] && exit 0
[ ! -f "$FILE" ] && exit 0

DIR=$(dirname "$FILE")
ESLINT=eslint
while [ "$DIR" != "/" ]; do
  if [ -x "$DIR/node_modules/.bin/eslint" ]; then ESLINT="$DIR/node_modules/.bin/eslint"; break; fi
  DIR=$(dirname "$DIR")
done
command -v "$ESLINT" &>/dev/null || exit 0

LINT_OUTPUT=$("$ESLINT" --quiet "$FILE" 2>&1)
[ $? -eq 0 ] && exit 0

jq -cn --arg f "${FILE##*/}" --arg o "$LINT_OUTPUT" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:("ESLint errors in \($f) — fix before declaring done:\n\($o)")}}'
exit 0
