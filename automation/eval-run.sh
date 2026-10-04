#!/usr/bin/env bash
# The deny list seals the answer key: ~/.claude (flaws.json, transcripts, plans) and the source repos' .git stay unreachable from the sandbox.
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
. "$(dirname "$0")/eval-lib.sh"

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "usage: eval-run.sh <case-id> <model> <effort> [prompt-override]" >&2
  exit 1
fi
CASE=$1 MODEL=$2 EFFORT=$3
DIR="$EVAL_ROOT/cases/$CASE"
[ -f "$DIR/kind" ] || { echo "ERROR no such case: $DIR" >&2; exit 1; }
KIND=$(<"$DIR/kind")

ALLOW=(Read Grep Glob)
DENY=(Edit Write NotebookEdit Agent "Bash(pnpm *)" "Bash(npm *)" "Bash(npx *)"
  mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue
  mcp__chrome-devtools__click mcp__chrome-devtools__fill mcp__chrome-devtools__fill_form
  mcp__chrome-devtools__navigate_page mcp__chrome-devtools__evaluate_script
  "Read(~/**)" "Grep(~/**)" "Glob(~/**)"
  "Read(//private/tmp/claude-501/**)" "Grep(//private/tmp/claude-501/**)" "Glob(//private/tmp/claude-501/**)")

SB=$(mktemp -d) || exit 1
trap 'rm -rf "$SB"' EXIT
build_sandbox "$DIR" "$SB" || exit 1

if [ $# -eq 4 ]; then
  BRIEF=$4
  prefix="$MODEL-$EFFORT-probe"
elif [ "$KIND" = plan ]; then
  BRIEF=$(grep -o '"Read <path>\.[^"]*Do not redesign\."' "$HOME/.claude/plan-mode.md" | head -n 1)
  if [ -z "$BRIEF" ]; then
    echo "ERROR cold-read brief not found in $HOME/.claude/plan-mode.md (expected a quoted string from \"Read <path>. through Do not redesign.)" >&2
    exit 1
  fi
  BRIEF=${BRIEF#\"}
  BRIEF=${BRIEF%\"}
  BRIEF=${BRIEF//"<path>"/$SB/REVIEW_INPUT.md}
  prefix="$MODEL-$EFFORT"
else
  BRIEF='Review the change in input.diff, already applied in this checkout. Report every defect that would cause wrong behavior, one per line as `<file>:<line> — <defect>`. Do not report style. Do not fix anything.'
  prefix="$MODEL-$EFFORT"
fi

OUT_DIR="$EVAL_STATE/$CASE"
mkdir -p "$OUT_DIR"
n=1
while [ -e "$OUT_DIR/$prefix-$n.jsonl" ]; do n=$((n + 1)); done
out="$OUT_DIR/$prefix-$n.jsonl"

(cd "$SB" && "$CLAUDE_BIN" -p "$BRIEF" --model "$MODEL" --effort "$EFFORT" --no-session-persistence \
  --output-format stream-json --verbose --permission-mode dontAsk --setting-sources project,local \
  --allowedTools "${ALLOW[@]}" --disallowedTools "${DENY[@]}") </dev/null >"$out" 2>"$out.err"

jq -e 'select(.type=="result") | .is_error == false' "$out" >/dev/null \
  || { echo "ERROR run failed: $out (stderr in $out.err)" >&2; exit 1; }
echo "$out"
