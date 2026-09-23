#!/usr/bin/env bash
# PostToolUse on Write|Edit. Advisory arm of "Model tier by work KIND" (~/.claude/subagent-tiers.md):
# the hook on Agent keeps DISPATCHES on tier, but nothing observes an Opus main thread typing the
# edits itself. Fires once per session, after the 3rd distinct file, and only from an Opus-or-above
# main thread — one file is the rule's own escape hatch, and a worker is already on its tier.
IN=$(cat)

[ -n "$(jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
F=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
[ -n "$SID" ] && [ -n "$F" ] && [ -r "$T" ] || exit 0

# Same oracle as enforce-subagent-model.sh: the live model, not settings.json.
MODEL=$(tail -c 200000 "$T" 2>/dev/null \
  | jq -rR 'fromjson? | select(.type? == "assistant") | .message.model // empty' 2>/dev/null | tail -1)
case "$MODEL" in *opus*|*fable*) ;; *) exit 0 ;; esac

FLAG="/tmp/claude-opus-write-nudge-$SID"
[ -e "$FLAG" ] && exit 0
SEEN="/tmp/claude-opus-write-files-$SID"
grep -qxF "$F" "$SEEN" 2>/dev/null || printf '%s\n' "$F" >>"$SEEN"
[ "$(wc -l <"$SEEN" | tr -d ' ')" -ge 3 ] || exit 0
touch "$FLAG"

printf 'This Opus thread has now written 3 files itself. Per "Model tier by work KIND" (~/.claude/CLAUDE.md), mechanical writing — code, docs, config — belongs to the Sonnet `implementer`: Opus specifies, then reviews the diff and runs the verify gate.\nIf the remaining work is prescriptive, write the plan and dispatch `implementer` for it. If every edit genuinely carries a design call, say so in one line and keep going.\n' >&2
exit 2
