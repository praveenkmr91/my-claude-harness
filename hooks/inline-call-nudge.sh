#!/usr/bin/env bash
# Advisory arm of the CLAUDE.md "Direct tool" rule; main thread only, every model tier.
#   count (default): fires on the 4th, 8th, 12th … counted lookup until a reset or this turn states `direct: continue — <why>`.
#   reset: a dispatch, a message to a running agent, a write or a typed prompt ends the lookup phase.
IN=$(cat)
MODE=${1:-count}

[ -n "$(jq -r '.agent_id // empty' <<<"$IN" 2>/dev/null)" ] && exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN" 2>/dev/null)
[ -n "$SID" ] || exit 0
TOOL=$(jq -r '.tool_name // empty' <<<"$IN" 2>/dev/null)
T=$(jq -r '.transcript_path // empty' <<<"$IN" 2>/dev/null)

COUNT="/tmp/claude-inline-calls-$SID"

if [ "$MODE" = reset ]; then
  PROMPT=$(jq -r '.prompt // empty' <<<"$IN" 2>/dev/null)
  grep -qE '<task-notification>|\[SYSTEM NOTIFIC|<agent-message' <<<"$PROMPT" && exit 0
fi

case "$MODE:$TOOL" in
  reset:*|*:Agent|*:SendMessage|*:Edit|*:Write|*:NotebookEdit)
    : >"$COUNT"
    exit 0 ;;
esac

case "$TOOL" in
  Read|Grep|Glob) ;;
  Bash)
    jq -e -L "$(dirname "${BASH_SOURCE[0]}")/lib" 'include "lookup"; (.tool_input.command // "") | is_lookup' <<<"$IN" >/dev/null 2>&1 || exit 0 ;;
  *) exit 0 ;;
esac

printf '.\n' >>"$COUNT"
N=$(wc -l <"$COUNT" | tr -d ' ')
[ "$N" -ge 4 ] && [ $((N % 4)) -eq 0 ] || exit 0

# Assistant text since the last typed prompt states why the target is known; a bare `direct: continue` or one with nothing after the dash does not match.
skipped() {
  jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -rR 'include "turns"; fromjson? |
    (typed_text | "U"), (assistant_text | "A " + gsub("\n"; " "))' "$T" 2>/dev/null \
    | awk '$0 == "U" { buf = ""; next } { buf = buf "\n" $0 } END { print buf }' \
    | grep -qE 'direct: continue[[:space:]]*(—|–|-)+[[:space:]]*[^[:space:]]'
}

[ -r "$T" ] || exit 0
skipped && exit 0

printf 'This thread has made %s direct lookups (Read/Grep/Glob/Bash) since the last typed prompt, agent dispatch or write. Per "Direct tool" in ~/.claude/CLAUDE.md, a known target gets ≤3 direct calls per question; the 4th goes to `Explore` (Haiku), or `checker` for a known grep. Dispatch, or state `direct: continue — <why the target is known>`. This repeats every 4 calls.\n' "$N" >&2
exit 2
