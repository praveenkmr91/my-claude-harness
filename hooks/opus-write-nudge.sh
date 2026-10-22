#!/usr/bin/env bash
# Write|Edit PreToolUse hook, enforcing arm of ~/.claude/subagent-tiers.md; Opus-or-above main thread only, subagents skipped.
#   From a Fable session, blocks every source write outright — Fable never writes code unless the last typed prompt carries [tier-override: <why>].
#   From Opus, blocks every source write of a turn until implementer was dispatched since the last typed prompt, this turn
#   states `implementer: skip — open call: <item>`, or the last typed prompt carries [tier-override: <why>].
#   No retry pass: a one-shot block let "small" / "in context" skips through (2026-10-11).
IN=$(cat)

[ -n "$(jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
F=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
T=$(jq -r '.transcript_path // empty' <<<"$IN")
[ -n "$SID" ] && [ -n "$F" ] && [ -r "$T" ] || exit 0
grep -qE '\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)$' <<<"$F" || exit 0

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

# Assistant text since the last typed prompt names an open call; a generic reason does not match.
skipped() {
  jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -rR 'include "turns"; fromjson? |
    (typed_text | "U"), (assistant_text | "A " + gsub("\n"; " "))' "$T" 2>/dev/null \
    | awk '$0 == "U" { buf = ""; next } { buf = buf "\n" $0 } END { print buf }' \
    | grep -qE 'implementer: skip[[:space:]]*(—|–|-)+[[:space:]]*open call:[[:space:]]*[^[:space:]]'
}

# Typed prompts only: tool_result blocks, isMeta records, compaction summaries and `<`-prefixed harness wrappers (except pasted blocks) quote override tags too.
typed_prompts() {
  jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -rR 'include "turns"; fromjson? | typed_text | gsub("\n"; " ")' 2>/dev/null
}

# Last typed prompt carries [tier-override: <why>] — the same escape enforce-subagent-model.sh takes; a new typed prompt without it re-arms.
overridden() {
  typed_prompts <"$T" | tail -1 | grep -q '\[tier-override:'
}

case "$MODEL" in *fable*)
  overridden && exit 0
  printf 'This thread runs Fable, and Fable never writes code (~/.claude/subagent-tiers.md). Dispatch `implementer` with the exact edit (file, old text, new text, acceptance check); docs, config and plan files stay direct. No skip line lifts this and a retry stays blocked; a typed prompt carrying `[tier-override: <why>]` lifts it for that turn.\n' >&2
  exit 2 ;;
esac
overridden && exit 0
[ -n "$(dispatched)" ] && exit 0
skipped && exit 0
printf 'This Opus thread is about to write source (%s) with no `implementer` dispatch this turn. Per ~/.claude/subagent-tiers.md a settled edit goes to `implementer`, one step per dispatch. Dispatch it, state `implementer: skip — open call: <the design call still undecided>`, or carry `[tier-override: <why>]` in the typed prompt. Size, urgency and loaded context are not open calls; a plain retry stays blocked.\n' "$F" >&2
exit 2
