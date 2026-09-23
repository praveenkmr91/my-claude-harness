#!/usr/bin/env bash
# Bytes since the last compact boundary approximate live context; 600KB ≈ >100k tokens.
IN=$(cat)
P=$(jq -r '.prompt // ""' <<<"$IN")
case "$P" in *'<task-notification>'*|*'[SYSTEM NOTIFICATION'*) exit 0;; esac
SID=$(jq -r '.session_id // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
[ -n "$SID" ] && [ -f "$T" ] || exit 0
FLAG="/tmp/claude-context-nudge-$SID"
[ -e "$FLAG" ] && exit 0
START=$(grep -n '"subtype":"compact_boundary"' "$T" | tail -1 | cut -d: -f1)
BYTES=$(tail -n +"${START:-1}" "$T" | wc -c | tr -d ' ')
[ "$BYTES" -gt 600000 ] || exit 0
touch "$FLAG"
echo "<context-nudge>Context is large (~$((BYTES/1024))KB of transcript since last compact). If this prompt starts a new task, tell Praveen in one line to /clear first — a stale session costs more per turn than a fresh one.</context-nudge>"
