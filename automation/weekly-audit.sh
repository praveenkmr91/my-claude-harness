#!/usr/bin/env bash
# The deny list is what keeps this read-only: a repo's own settings can pre-allow mutating commands
# (roboinvest-frontend allows `pnpm resourceset:sync --apply`), and --allowedTools only adds to those.
set -u
export PATH="/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/usr/bin:/bin"

SCRIPTS="$HOME/.claude/skills/a11y-audit/scripts"
PROMPT='No cap. Run three audits on this repo in sequence: /delete-audit; improve-codebase-architecture as a report only (skip grilling, write no HTML); a11y-audit scan phase only, no fixes. Bash allows only single commands of `git log ...` and `python3 '"$SCRIPTS"'/...` with that exact absolute path (no pipes, chains or ~): run the a11y scanner and contrast checker and mine git log for hot spots that way; use Read, Grep and Glob for everything else. Stamping is automatic. Reply with one ranked markdown report, biggest finding first, with file:line on every finding.'
ALLOW=(Read Grep Glob Skill "Bash(python3 $SCRIPTS/*)")
DENY=(Edit Write NotebookEdit Agent "Bash(pnpm *)" "Bash(npm *)" "Bash(npx *)"
  mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue
  mcp__chrome-devtools__click mcp__chrome-devtools__fill mcp__chrome-devtools__fill_form
  mcp__chrome-devtools__navigate_page mcp__chrome-devtools__evaluate_script)

day=$(date +%F)
reports=() failed=()
for repo in "$@"; do
  name=$(basename "$repo")
  dir="$HOME/.claude/state/audits/$name"
  out="$repo/docs/audits"
  mkdir -p "$dir" "$out"
  if (cd "$repo" && claude -p "$PROMPT" --output-format json --effort medium --permission-mode dontAsk \
        --no-session-persistence --max-budget-usd 10 --allowedTools "${ALLOW[@]}" --disallowedTools "${DENY[@]}") \
        > "$dir/$day.json" 2> "$dir/$day.err" \
     && jq -e '.is_error == false' "$dir/$day.json" > /dev/null; then
    jq -r '.result' "$dir/$day.json" > "$out/$day.md"
    reports+=("$out/$day.md")
  else
    failed+=("$name (log: $dir/$day.err)")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  msg="Failed: ${failed[*]}"
else
  msg="Reports: ${reports[*]}"
fi
osascript -e "display notification \"$msg\" with title \"Weekly audit\""
[ ${#failed[@]} -eq 0 ]
