#!/usr/bin/env bash
# SessionStart: tell the session a census recount report (state/census/<name>/latest.md) is waiting, until `touch state/census/acked` acknowledges it.
# Plain stdout on purpose: on SessionStart it reaches the model, which is who the reminder is for; a systemMessage would reach only Praveen.
# Every failure path exits 0 silently.
IN=$(exec cat)
case "$(exec jq -r '.source // empty' <<<"$IN" 2>/dev/null)" in startup|resume) ;; *) exit 0 ;; esac
DIR="$HOME/.claude/state/census"
REPORT=$(ls -t "$DIR"/*/latest.md 2>/dev/null | head -1)
[ -n "$REPORT" ] && [ "$REPORT" -nt "$DIR/acked" ] || exit 0
printf 'Census recount report waiting: %s. Read it, and any baseline-*.md beside it (a baseline frozen before old transcripts were deleted), and give Praveen its before/after comparison in your first reply, unasked, then run: touch %s/acked\n' "$REPORT" "$DIR"
