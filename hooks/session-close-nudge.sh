#!/usr/bin/env bash
# Stop hook: tells the user to close a session that has compacted twice or more, once per compaction count.
# Counts the compact_boundary system records in the whole transcript, manual and auto alike, sidechain records excluded; a tail read would miss early ones.
# Output is a systemMessage: shown to the user, never blocking and never a model turn.
# The last count nudged is kept per session and is never reset on compaction, so the same count stays quiet and the next one speaks.
# Fails open (exit 0, silent) on a subagent, an unreadable transcript or no session id.
IN=$(exec cat)

[ -n "$(exec jq -r '.agent_id // empty' <<<"$IN" 2>/dev/null)" ] && exit 0
SID=$(exec jq -r '.session_id // empty' <<<"$IN" 2>/dev/null)
T=$(exec jq -r '.transcript_path // empty' <<<"$IN" 2>/dev/null)
[ -n "$SID" ] && [ -r "$T" ] || exit 0

COUNT=$(exec jq -nR '[inputs | fromjson? | select(.type? == "system" and .subtype? == "compact_boundary" and .isSidechain? != true)] | length' "$T" 2>/dev/null)
[ "${COUNT:-0}" -ge 2 ] || exit 0

SEEN="$HOME/.claude/state/close-nudge/$SID"
LAST=$(exec cat "$SEEN" 2>/dev/null)
[ "$COUNT" -gt "${LAST:-0}" ] || exit 0
mkdir -p "$(exec dirname "$SEEN")" && printf '%s\n' "$COUNT" >"$SEEN"

jq -n --arg m "This session has compacted $COUNT times. At the next stopping point: save state with /remember:remember, close it and start a new session." '{systemMessage: $m}'
