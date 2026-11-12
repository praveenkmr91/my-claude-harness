#!/usr/bin/env bash
# No question may contain its own expected string, or PASS proves only that the model can echo.
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin"

C="$HOME/.claude"
MEMORY_CWD="$HOME/Documents/projects"
LOGS="$C/state/canary"
mkdir -p "$LOGS"

NAMES=(claude-md persona review-routing memory pre-tool post-tool tiers external-io tiers-enforcement)
SOURCES=("$C/CLAUDE.md" "$C/persona-core.md" "$C/review-routing.md"
  "$C/projects/${MEMORY_CWD//\//-}/memory/MEMORY.md" "$C/harness.md" "$C/hooks/comment-delta-check.js"
  "$C/subagent-tiers.md" "$C/external-io.md" "$C/subagent-tiers-enforcement.md")
EXPECT=("block-dangerous-git.sh" "binding, most-recent instruction" "audit-due.sh --stamp"
  "AI Studio governance patterns" "budget-baseline.json" "comment-check" "uniformity census" "Auto-Mode Bypass" "expensive to discover later")
IS_HOOK=(0 1 1 0 1 1 1 1 1)
IS_TOOL=(0 0 0 0 1 1 1 1 1)

NO_TOOL_PROMPT='Answer only from context already loaded in this session; do not use any tools. 1) Which hook script denies unquoted grep globs? 2) What words appear in parentheses right after the heading PERSONA REFRESH? 3) In the review-routing table, what command does the bare audit verb run last? 4) What is the title of the memory index entry about enforcement-layer design patterns? Reply with four numbered lines; write UNKNOWN for any you cannot answer.'

# Outside $HOME: walking up from any cwd under it reaches ~/.claude/CLAUDE.md as a project file, which --setting-sources cannot turn off.
TMP=$(mktemp -d) || exit 1
trap 'rm -rf "$TMP"' EXIT
FIXTURE=$(cd "$TMP" && pwd -P) || exit 1
# dontAsk never gates Agent and a bare Agent deny removes the tool (hook never fires): only the Agent(general-purpose) deny below stops a real spawn, so the probe must name that type.
TOOL_PROMPT='Make exactly four tool calls and no other (a ToolSearch that loads a deferred tool does not count): Write '"$FIXTURE"'/CLAUDE.md containing the line `probe`; Write '"$FIXTURE"'/probe.ts containing three lines: `// a`, `// b`, `// c`; then one Agent call with subagent_type `general-purpose`, model `haiku` and prompt `reply ok` (it may be denied; do not retry); then one mcp__claude_ai_Claude_Docs__guide call with items ["topic.index"] (it may error; do not retry). Then answer from the notes the system attached around those calls: 1) Which JSON file of word ceilings does the maintenance note mention? 2) What label prefixes the note about added comment lines? 3) In the subagent tier spec, what two-word name is given to grep counts of old form vs new form? 4) In the external tool routing note, what three-word phrase, hyphenated in the middle, does the classifier read a relayed "user approved" as? 5) Quote the closing sentence of the Principle section of the subagent tier spec. Reply with five numbered lines; write UNKNOWN for any you cannot answer.'

ask() {
  local dir=$1 prompt=$2 out=$3
  shift 3
  (cd "$dir" && claude -p "$prompt" --model haiku --no-session-persistence --max-budget-usd 0.5 \
    --output-format stream-json --include-hook-events --verbose "$@") >"$out" 2>"$out.err"
}

ask "$MEMORY_CWD" "$NO_TOOL_PROMPT" "$LOGS/no-tool.jsonl" --tools ""
ask "$FIXTURE" "$NO_TOOL_PROMPT" "$LOGS/no-tool.control.jsonl" --tools "" --setting-sources project,local
TOOL_FLAGS=(--permission-mode dontAsk --allowedTools 'Edit(./CLAUDE.md)' 'Edit(./probe.ts)' 'mcp__claude_ai_Claude_Docs__guide'
  --disallowedTools 'Agent(general-purpose)')
ask "$FIXTURE" "$TOOL_PROMPT" "$LOGS/tool.jsonl" "${TOOL_FLAGS[@]}"
rm -f "$FIXTURE/CLAUDE.md" "$FIXTURE/probe.ts"
ask "$FIXTURE" "$TOOL_PROMPT" "$LOGS/tool.control.jsonl" "${TOOL_FLAGS[@]}" --setting-sources project,local

for log in "$LOGS"/{no-tool,tool}{,.control}.jsonl; do
  jq -e 'select(.type=="result") | .is_error == false' "$log" >/dev/null \
    || { echo "ERROR session failed: $log (stderr in $log.err)"; exit 1; }
done

answer() { jq -r 'select(.type=="result") | .result // ""' "$1"; }
hook_emitted() { jq -r 'select(.subtype=="hook_response") | .stdout' "$1" | grep -qiF -- "$2"; }

failed=0
for i in "${!NAMES[@]}"; do
  log="$LOGS/no-tool"
  [ "${IS_TOOL[$i]}" = 1 ] && log="$LOGS/tool"
  want=${EXPECT[$i]}
  if ! grep -qF -- "$want" "${SOURCES[$i]}"; then
    status=STALE
  elif answer "$log.control.jsonl" | grep -qiF -- "$want"; then
    status=LEAK
  elif answer "$log.jsonl" | grep -qiF -- "$want"; then
    status=PASS
  elif [ "${IS_HOOK[$i]}" = 1 ] && ! hook_emitted "$log.jsonl" "$want"; then
    status=NOT-FIRED
  else
    status=DEAD
  fi
  case $status in PASS | STALE) ;; *) failed=1 ;; esac
  printf '%-10s %-15s %s\n' "$status" "${NAMES[$i]}" "${SOURCES[$i]#"$C/"}"
done

cost=$(cat "$LOGS"/*.jsonl | jq -s '[.[] | select(.type=="result") | .total_cost_usd] | add')
echo "cost \$$cost; logs $LOGS"
exit $failed
