#!/usr/bin/env bash
# claude-hud --extra-cmd gets no stdin, so the session is found by walking up
# to the Claude process that owns ~/.claude/sessions/<pid>.json.
sessions="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"
pid=$PPID
while [ "${pid:-1}" -gt 1 ]; do
  if [ -f "$sessions/$pid.json" ]; then
    jq -r 'if .nameSource == "derived" then "@" + (.name | split("-") | last) else "@" + .name end' "$sessions/$pid.json" 2>/dev/null
    exit 0
  fi
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
done
