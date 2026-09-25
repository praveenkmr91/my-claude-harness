#!/usr/bin/env bash
# SessionStart: tell the user when this repo has no audit on record in 30 days. `--stamp` records one (run from the repo);
# `--on-skill` (PostToolUse Skill) stamps automatically when an audit-verb skill runs.
# Every failure path exits 0 silently.
if [ "$1" != --stamp ]; then
  IN=$(cat)
  if [ "$1" = --on-skill ]; then
    case "$(jq -r '.tool_input.skill // empty' <<<"$IN" | sed 's/.*://')" in
      delete-audit|a11y-audit|web-quality-audit|core-web-vitals|improve-codebase-architecture) set -- --stamp ;;
      *) exit 0 ;;
    esac
  else
    [ "$(jq -r '.source // empty' <<<"$IN")" = startup ] || exit 0
  fi
  cd "$(jq -r '.cwd // empty' <<<"$IN")" 2>/dev/null || exit 0
fi
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
DIR="$HOME/.claude/state/audit"
STAMP="$DIR/$(tr '/' '_' <<<"$TOP")"
if [ "$1" = --stamp ]; then mkdir -p "$DIR" && touch "$STAMP"; exit 0; fi
[ -n "$(find "$STAMP" -mtime -30 2>/dev/null)" ] && exit 0
if [ -e "$STAMP" ]; then AGE="last audit $(( ($(date +%s) - $(date -r "$STAMP" +%s)) / 86400 )) days ago"; else AGE="no audit on record"; fi
jq -n --arg m "Audit due for $(basename "$TOP") ($AGE) — type \`audit\` when convenient." '{systemMessage: $m}'
