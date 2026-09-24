#!/usr/bin/env bash
# SessionStart: nudge a bare audit when this repo has none on record in 30 days. `--stamp` records one (run from the repo).
# Every failure path exits 0 silently.
if [ "$1" != --stamp ]; then
  IN=$(cat)
  [ "$(jq -r '.source // empty' <<<"$IN")" = startup ] || exit 0
  cd "$(jq -r '.cwd // empty' <<<"$IN")" 2>/dev/null || exit 0
fi
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
DIR="$HOME/.claude/state/audit"
STAMP="$DIR/$(tr '/' '_' <<<"$TOP")"
if [ "$1" = --stamp ]; then mkdir -p "$DIR" && touch "$STAMP"; exit 0; fi
[ -n "$(find "$STAMP" -mtime -30 2>/dev/null)" ] && exit 0
if [ -e "$STAMP" ]; then AGE="last audit $(( ($(date +%s) - $(date -r "$STAMP" +%s)) / 86400 )) days ago"; else AGE="no audit on record"; fi
MSG="Audit due for $(basename "$TOP") ($AGE)."
jq -n --arg m "$MSG" '{systemMessage: $m, hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: ($m + " Offer the user a bare `audit` once, at a natural break. After it completes, or if they decline, run `bash ~/.claude/hooks/audit-due.sh --stamp` from the repo (declining snoozes 30 days).")}}'
