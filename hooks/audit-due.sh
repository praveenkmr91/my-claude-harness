#!/usr/bin/env bash
# SessionStart: tell the user when this repo has had no audit in 30 days; the first startup in a repo starts that clock
# silently rather than nudging every session until the first audit. `--stamp` records one (run from the repo);
# `--on-skill` (PostToolUse Skill) stamps automatically when an audit-verb skill runs.
# It also lands the weekly audit's newest report into docs/audits/audit.md: launchd's bash may not write under
# ~/Documents (macOS privacy), while a session here can.
# Every failure path exits 0 silently.
if [ "$1" != --stamp ]; then
  IN=$(cat)
  if [ "$1" = --on-skill ]; then
    case "$(jq -r '.tool_input.skill // empty' <<<"$IN" | sed 's/.*://')" in
      delete-audit|a11y-audit|web-quality-audit|core-web-vitals|improve-codebase-architecture) set -- --stamp ;;
      *) exit 0 ;;
    esac
  else
    SOURCE=$(jq -r '.source // empty' <<<"$IN")
    case "$SOURCE" in startup|resume) ;; *) exit 0 ;; esac
  fi
  cd "$(jq -r '.cwd // empty' <<<"$IN")" 2>/dev/null || exit 0
fi
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
if [ "$1" != --stamp ]; then
  REPORT=$(ls -t "$HOME/.claude/state/audits/$(basename "$TOP")"/*.md 2>/dev/null | head -1)
  LANDED="$TOP/docs/audits/audit.md"
  if [ -n "$REPORT" ] && [ "$REPORT" -nt "$LANDED" ] && mkdir -p "$TOP/docs/audits" && cp "$REPORT" "$LANDED"; then
    jq -n --arg m "Weekly audit $(basename "$REPORT" .md) landed in docs/audits/audit.md — review and commit it." '{systemMessage: $m}'
    exit 0
  fi
  [ "$SOURCE" = startup ] || exit 0
fi
DIR="$HOME/.claude/state/audit"
STAMP="$DIR/$(tr '/' '_' <<<"$TOP")"
if [ "$1" = --stamp ] || [ ! -e "$STAMP" ]; then mkdir -p "$DIR" && touch "$STAMP"; exit 0; fi
[ -n "$(find "$STAMP" -mtime -30 2>/dev/null)" ] && exit 0
DAYS=$(( ($(date +%s) - $(date -r "$STAMP" +%s)) / 86400 ))
jq -n --arg m "Audit due for $(basename "$TOP") (no audit in $DAYS days) — type \`audit\` when convenient." '{systemMessage: $m}'
