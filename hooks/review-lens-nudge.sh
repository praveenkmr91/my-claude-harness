#!/usr/bin/env bash
# PostToolUse Write|Edit: surfaces the classifier's lenses mid-turn, so verdict lines land before done-claim-gate.sh's one-shot Stop check.
# Every failure path exits 0 silently.
IN=$(cat)
HOOKS=$(cd "$(dirname "$0")" && pwd)
FILE=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
grep -qE '\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)$' <<<"$FILE" || exit 0
cd "$(dirname "$FILE")" 2>/dev/null || exit 0
CLASSIFIED=$(python3 "$HOOKS/review-classify.py" <<<"$IN")
LENSES=$(grep -oE 'lenses=[^ ]+' <<<"$CLASSIFIED" | cut -d= -f2)
[ -n "$LENSES" ] || exit 0
REQUIRED=$(grep -oE 'required=[^ ]+' <<<"$CLASSIFIED" | cut -d= -f2)
TRANSCRIPT=$(jq -r '.transcript_path // empty' <<<"$IN")
# Keyed on the latest typed prompt: a new turn re-nudges even when the lens set is unchanged.
PROMPT=$( [ -r "$TRANSCRIPT" ] && jq -c 'select(.type=="user" and (.message.content|type=="string"))' "$TRANSCRIPT" 2>/dev/null | tail -1)
KEY=$(printf '%s\n%s\n%s' "$PROMPT" "$LENSES" "$REQUIRED" | shasum | cut -c1-16)
STATE="/tmp/claude-review-lenses-$(jq -r '.session_id // "none"' <<<"$IN")"
[ "$(cat "$STATE" 2>/dev/null)" = "$KEY" ] && exit 0
echo "$KEY" > "$STATE"
OWED=""
[ -n "$REQUIRED" ] && [ "$REQUIRED" != none ] && [ -z "$(jq -r '.agent_id // empty' <<<"$IN")" ] && OWED="${REQUIRED//,/, }"
jq -n --arg l "${LENSES//,/, }" --arg r "$OWED" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("Review lenses for this change: " + $l + ". Before claiming done or asking to commit, give each a reply line `<lens>: N findings` or `<lens>: skip — <reason>` (hand pass first, agent only on a lead)." + (if $r == "" then "" else " Required members: " + $r + ". Run `delete-list` and `security-review` as skills and the rest as agents, each with an `effort` before a done-claim; a typed line does not count for them." end))}}'
