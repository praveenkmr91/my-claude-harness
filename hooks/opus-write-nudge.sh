#!/usr/bin/env bash
# Write|Edit PreToolUse hook, enforcing arm of ~/.claude/subagent-tiers.md; Opus-or-above main thread only, subagents skipped.
#   From a Fable session, blocks every source write outright — Fable never writes code unless the last typed prompt carries [tier-override: <why>].
#   From Opus, blocks every source write of a turn until implementer was dispatched since the last typed prompt, or the last typed prompt carries [tier-override: <why>].
#   Both arms pass harness files under ~/.claude/ (plugin caches aside): those stay the main thread's.
#   No retry pass: a one-shot block let "small" / "in context" skips through (2026-10-11).
#   Also gates shell code edits (sed -i, perl -pi, git mv, git rm) relayed by bash-write-guard.js as shell_targets / unresolved_in.
IN=$(cat)

[ -n "$(jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
CODE_EXT='\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)$'
SID=$(jq -r '.session_id // empty' <<<"$IN")
F=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
if [ -z "$F" ]; then
  F=$(jq -r '.tool_input.shell_targets[]? // empty' <<<"$IN" | grep -E "$CODE_EXT" | head -1)
  [ -z "$F" ] && F=$(jq -r '.tool_input.unresolved_in // empty' <<<"$IN") && [ -n "$F" ] && UNRESOLVED=1
fi
[ -n "$SID" ] && [ -n "$F" ] && [ -r "$T" ] || exit 0
[ -n "$UNRESOLVED" ] || grep -qE "$CODE_EXT" <<<"$F" || exit 0

# Same oracle as enforce-subagent-model.sh: the live model, not settings.json.
MODEL=$(tail -c 200000 "$T" 2>/dev/null \
  | jq -rR 'fromjson? | select(.type? == "assistant") | .message.model // empty' 2>/dev/null | tail -1)
case "$MODEL" in *opus*|*fable*) ;; *) exit 0 ;; esac

# Parsed, not grepped: harness sessions quote "subagent_type":"implementer" in Bash output.
dispatched() {
  jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -rR 'include "turns"; fromjson? |
    (typed_text | "U"),
    (select(.type? == "assistant") | .message.content[]? | select(.type? == "tool_use" and .input.subagent_type? == "implementer") | "D")' "$T" 2>/dev/null \
    | awk '$0 == "U" { buf = ""; next } { buf = buf "\n" $0 } END { print buf }' \
    | grep D | head -1
}

# Typed prompts only: tool_result blocks, isMeta records, compaction summaries and `<`-prefixed harness wrappers (except pasted blocks) quote override tags too.
typed_prompts() {
  jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -rR 'include "turns"; fromjson? | typed_text | gsub("\n"; " ")' 2>/dev/null
}

# Last typed prompt carries [tier-override: <why>] — the same escape enforce-subagent-model.sh takes; a new typed prompt without it re-arms.
overridden() {
  typed_prompts <"$T" | tail -1 | grep -q '\[tier-override:'
}

# Harness files are the main thread's to write: a hook edit is small and judgment-dense, so a prescriptive implementer brief outgrows the diff (2026-11-06). Plugin caches stay blocked: curation there reverts on update.
case "$F" in "$HOME/.claude/plugins/"*) ;; "$HOME/.claude/"*) exit 0 ;; esac

case "$MODEL" in *fable*)
  overridden && exit 0
  printf 'Do not retry this write: the harness blocks it and the same call gets the same denial. This thread runs Fable, and Fable never writes code; dispatch `implementer` with this exact edit, or ask the user to type `[tier-override: <why>]` (~/.claude/subagent-tiers.md).\n' >&2
  exit 2 ;;
esac
# Session scratchpad: throwaway probes never ship, so tier routing buys nothing (bash-write-guard.js passes temp-dir output too).
grep -qE '^(/private)?/tmp/claude-[0-9]+/[^/]+/[^/]+/scratchpad/' <<<"$F" && exit 0
overridden && exit 0
[ -n "$(dispatched)" ] && exit 0
printf 'Do not retry this write: the harness blocks it and the same call gets the same denial. This Opus thread is about to write source (%s) with no `implementer` dispatch this turn; dispatch `implementer` with this exact edit, or ask the user to type `[tier-override: <why>]`. Size, urgency and loaded context never lift it (~/.claude/subagent-tiers.md).\n' "$F" >&2
exit 2
