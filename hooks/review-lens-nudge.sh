#!/usr/bin/env bash
# PostToolUse Write|Edit: surfaces the classifier's lenses mid-turn, so verdict lines land before done-claim-gate.sh's one-shot Stop check.
# Every failure path exits 0 silently.
IN=$(cat)
HOOKS=$(cd "$(dirname "$0")" && pwd)
grep -qE '\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)$' <<<"$(jq -r '.tool_input.file_path // empty' <<<"$IN")" || exit 0
cd "$(jq -r '.cwd // empty' <<<"$IN")" 2>/dev/null || exit 0
LENSES=$(bash "$HOOKS/review-classify.sh" <<<"$IN" | grep -oE 'lenses=[^ ]+' | cut -d= -f2)
[ -n "$LENSES" ] || exit 0
TRANSCRIPT=$(jq -r '.transcript_path // empty' <<<"$IN")
# Keyed on the latest typed prompt: a new turn re-nudges even when the lens set is unchanged.
PROMPT=$( [ -r "$TRANSCRIPT" ] && jq -c 'select(.type=="user" and (.message.content|type=="string"))' "$TRANSCRIPT" 2>/dev/null | tail -1)
KEY=$(printf '%s\n%s' "$PROMPT" "$LENSES" | shasum | cut -c1-16)
STATE="/tmp/claude-review-lenses-$(jq -r '.session_id // "none"' <<<"$IN")"
[ "$(cat "$STATE" 2>/dev/null)" = "$KEY" ] && exit 0
echo "$KEY" > "$STATE"
jq -n --arg l "${LENSES//,/, }" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("Review lenses for this change: " + $l + ". Before claiming done or asking to commit, give each a reply line `<lens>: N findings` or `<lens>: skip — <reason>` (hand pass first, agent only on a lead).")}}'
