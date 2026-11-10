#!/usr/bin/env bash
# Read-only rests on --setting-sources user (no repo settings, hooks or allows load), the static --disallowedTools
# list, and a deny file passed with --settings, built from the user's allow rules (minus Read/Grep/Glob/git log).
# Rules never go on the command line: the CLI reads a leading `-` as a flag and re-splits a rule with inner parentheses.
set -u
export PATH="/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/usr/bin:/bin"

SCRIPTS="$HOME/.claude/skills/a11y-audit/scripts"
PROMPT='No cap. Project instructions are not loaded, so read CLAUDE.md and CLAUDE.local.md at the repo root first when they exist. Run four audits on this repo in sequence: /delete-audit; improve-codebase-architecture as a report only (skip grilling, write no HTML); colour contrast only, with the a11y-audit contrast checker (the repo'"'"'s jsx-a11y lint and axe tests already cover the scanner'"'"'s rules); a security review by hand of packages/core/auth, packages/core/app-token, packages/core/transport and packages/data against docs/webview-module-architecture-v3.md §4: credentials or tokens in browser storage, URLs or logs, raw HTML sinks, open redirects, and requests that bypass the auth layer. Bash allows only single commands of `git log ...` and `python3 '"$SCRIPTS"'/...` with that exact absolute path (no pipes, chains or ~): run the contrast checker and mine git log for hot spots that way; use Read, Grep and Glob for everything else. Stamping is automatic. If docs/audits/audit.md exists it is last week'"'"'s report: read it first and tag every finding NEW, OPEN (still present) or FIXED (listed there, gone now). Rate every finding, a11y or not, on the a11y-audit scale: Critical blocks a user group or touches a credential or security path; Major is a real barrier or debt that costs work now (an AA failure, code that changes together in 3+ places); Minor is friction or dead weight. Reply with one markdown report under ## Critical, ## Major and ## Minor headings in that order (omit an empty one), biggest finding first within each and unverified ones last. Every finding carries file:line and ends with one **Fix:** line naming the concrete change; for an unverified finding the fix is the check that would confirm it.'
# Named skills and scripts only: a bare Skill admits a command whose allowed-tools grants Bash, and a `*` path reaches ../.
ALLOW=(Read Grep Glob "Skill(delete-audit)" "Skill(improve-codebase-architecture)" "Skill(a11y-audit)"
  "Bash(python3 $SCRIPTS/contrast_checker.py *)" "Bash(python3 $SCRIPTS/a11y_scanner.py *)")
DENY=(Edit Write NotebookEdit Agent "Bash(pnpm *)" "Bash(npm *)" "Bash(npx *)"
  mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue
  mcp__chrome-devtools__click mcp__chrome-devtools__fill mcp__chrome-devtools__fill_form
  mcp__chrome-devtools__navigate_page mcp__chrome-devtools__evaluate_script)

day=$(date +%F)
reports=() failed=()
user_settings="$HOME/.claude/settings.json"
audits="$HOME/.claude/state/audits"
deny_file="$audits/$day.deny.json"
setup_failure=""
if [ -f "$user_settings" ]; then
  if ! jq '(.permissions.allow // []) | if type == "array" and all(type == "string") then empty else error("bad") end' \
    "$user_settings" > /dev/null; then
    setup_failure="unreadable settings: $user_settings"
  fi
  settings_source="$user_settings"
else
  settings_source=/dev/null
fi
if [ -z "$setup_failure" ]; then
  mkdir -p "$audits"
  if ! jq -n '
    def covered: . as $rule
      | (["Read", "Grep", "Glob", "Bash(git log)", "Bash(git log:*)", "Bash(git log *)"] | any(. == $rule))
        or (["Read(", "Grep(", "Glob("] | any(. as $prefix | $rule | startswith($prefix)));
    {permissions: {deny: [inputs | .permissions.allow // [] | .[] | select(covered | not)]}}
  ' "$settings_source" < /dev/null > "$deny_file"; then
    setup_failure="deny file write: $deny_file"
  fi
fi
for repo in "$@"; do
  name=$(basename "$repo")
  if [ -n "$setup_failure" ]; then
    failed+=("$name ($setup_failure)")
    continue
  fi
  dir="$audits/$name"
  mkdir -p "$dir"
  # Runs here, not in the session: a deny beats any allow, so Bash(pnpm audit) can't be carved out of Bash(pnpm *).
  if advisories=$(cd "$repo" && pnpm audit --json 2>/dev/null | jq -er '.advisories | map("\(.severity)\t\(.module_name)@\(.vulnerable_versions)\t\(.title)\t\(.findings[0].paths[0])") | join("\n")' 2>/dev/null); then
    deps="Dependency advisories from pnpm audit, one per line as severity, package@vulnerable range, title, first dependency path (none if empty). Report them as security findings grouped per package, one tier lower when the path reaches only build or codegen tooling rather than app code:
$advisories"
  else
    deps='pnpm audit could not run this week; say so under scope notes.'
  fi
  prompt=$(printf '%s\n\n%s' "$PROMPT" "$deps")
  if (cd "$repo" && claude -p "$prompt" --output-format json --effort medium --permission-mode dontAsk \
        --no-session-persistence --max-budget-usd 10 --setting-sources user --settings "$deny_file" --allowedTools "${ALLOW[@]}" --disallowedTools "${DENY[@]}") \
        > "$dir/$day.json" 2> "$dir/$day.err" \
     && jq -e '.is_error == false' "$dir/$day.json" > /dev/null; then
    # Never into the repo directly: hooks/audit-due.sh lands it (why there).
    { printf '_Generated %s_\n\n' "$day"; jq -r '.result' "$dir/$day.json"; } > "$dir/$day.md" \
      && reports+=("$name") || failed+=("$name (report write: $dir/$day.md)")
  else
    failed+=("$name (log: $dir/$day.err)")
  fi
done

bash "$HOME/.claude/automation/context-canary.sh" || failed+=("context canary (log: $HOME/.claude/state/canary)")
bash "$HOME/.claude/automation/weekly-learn.sh" || failed+=("weekly learn (log: $HOME/.claude/state/learn)")

if [ ${#failed[@]} -gt 0 ]; then
  msg="Failed: ${failed[*]}"
elif [ ${#reports[@]} -eq 0 ]; then
  msg="No repos audited; canary and learn ran."
else
  msg="Reports ready for ${reports[*]}; they land in docs/audits/audit.md at the next session there."
fi
census="$HOME/.claude/state/census/review-by-size/run.js"
[ -f "$census" ] && line=$(node "$census" 2>/dev/null) && [ -n "$line" ] && msg="$msg · $line"
osascript -e "display notification \"$msg\" with title \"Weekly audit\""
[ ${#failed[@]} -eq 0 ]
