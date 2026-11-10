#!/usr/bin/env bash
# Read-only like weekly-audit.sh, and for the same reason: a repo's own settings can pre-allow mutating tools,
# and --allowedTools only adds to those. The deny list must therefore name every MCP server by hand.
set -u
export PATH="/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/usr/bin:/bin"

# tests/harness.test.js holds this list to the MCP servers settings.json pre-allows.
DENY=(Edit Write NotebookEdit Agent Bash Skill SendMessage
  mcp__chrome-devtools mcp__claude_ai_Atlassian_Rovo mcp__claude_ai_Figma mcp__plugin_context7_context7)

day=$(date +%F)
state="$HOME/.claude/state/learn"
digest="$state/digest/$day"
marker="$state/.run-$day"
mkdir -p "$state"
touch "$marker"

# A session that fails to digest is unread; moving the cursor past it would lose its lessons silently.
if ! bash "$HOME/.claude/automation/learn-digest.sh" "$HOME/.claude/projects" "$state/cursor" "$digest" 2> "$state/$day.err"; then
  rm -f "$marker"
  osascript -e "display notification \"Weekly learn: digest failed (log: $state/$day.err)\" with title \"Weekly learn\""
  exit 1
fi

sessions=$(find "$digest" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')
if [ "$sessions" -eq 0 ]; then
  rm -f "$marker"
  osascript -e 'display notification "Weekly learn: no sessions" with title "Weekly learn"'
  exit 0
fi

ADD_DIRS=()
while IFS= read -r cwd; do
  [ -n "$cwd" ] || continue
  top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) && [ "$top" = "$cwd" ] && ADD_DIRS+=("$cwd")
done < <(for file in "$digest"/*.md; do head -n 1 -- "$file" | sed 's/^.* · repo //'; done | sort -u)

PROMPT='Weekly learn run for '"$day"'. You are read-only: write nothing and reply with the report only. This week'"'"'s sessions are digested as one file each in '"$digest"': Glob *.md there and Read every file whole. Line 1 of a file is `# <session file> · repo <cwd>`; an optional line 2 notes a cut head; the rest are records prefixed `user: ` (typed prompts) and `assistant: ` (replies). Work the four steps of '"$HOME"'/.claude/commands/learn.md, adapted to a batch. (1) Pick at most 5 lessons across all sessions: a corrected mistake, a non-obvious root cause, a tool or library quirk, a convention the user confirmed. Skip typos, one-off outages and anything a repo or its git history already records. (2) For each lesson run the overlap check by Grep, and read the hits, across '"$HOME"'/.claude/CLAUDE.md and the rule docs it points to, '"$HOME"'/.claude/skills/*/SKILL.md, '"$HOME"'/.claude/commands/, every '"$HOME"'/.claude/projects/*/memory/ directory, and the CLAUDE.md of each repo named in a digest header. (3) Give each lesson exactly one verdict: Absorb into <file> (default: it sharpens a rule some tier already owns, so edit that rule in place), Save (no owner exists: a memory file when it is a fact about the user, a project or a reference; a skill only for a repeatable procedure) or Drop (trivial, one-off, or already covered as written). Pick the tier by reach: every project is global, one framework is the framework reference, one repo is project memory. (4) Write nothing: the report is the proposal, and a human decides each one later. Report shape: line 1 is `# Weekly learn '"$day"'` with no other header; then, per proposal, a heading `## Absorb into <file>: <title>` or `## Save <file>: <title>`. Each proposal carries a `Session:` line (the digest file), an `Evidence:` line (one quoted line from it), an `Overlap:` line (the tiers you grepped and the hit, or `none`) and a fenced diff or the new file body. Then `## Dropped` with one line per dropped lesson. The proposal count is the number of `## Absorb` and `## Save` headings, Drops excluded, at most 5.'

if [ ${#ADD_DIRS[@]} -gt 0 ]; then ADD_ARGS=(--add-dir "${ADD_DIRS[@]}"); else ADD_ARGS=(); fi

if (cd "$HOME/.claude" && claude -p "$PROMPT" --output-format json --model opus --effort medium --permission-mode dontAsk \
      --no-session-persistence --max-budget-usd 10 ${ADD_ARGS[@]+"${ADD_ARGS[@]}"} \
      --allowedTools Read Grep Glob --disallowedTools "${DENY[@]}") \
      > "$state/$day.json" 2> "$state/$day.err" \
   && jq -e '.is_error == false' "$state/$day.json" > /dev/null \
   && jq -r '.result' "$state/$day.json" > "$state/$day.md"; then
  if [ -e "$digest/kept-until" ]; then
    mv "$digest/kept-until" "$state/cursor"
    rm -f "$marker"
  else
    mv "$marker" "$state/cursor"
  fi
  proposals=$(grep -c '^## \(Absorb\|Save\)' "$state/$day.md")
  deferred=
  if [ -s "$digest/skipped.txt" ]; then deferred=", $(wc -l < "$digest/skipped.txt" | tr -d ' ') sessions deferred"; fi
  osascript -e "display notification \"Weekly learn report ready: $proposals proposals$deferred\" with title \"Weekly learn\""
  exit 0
fi

rm -f "$marker"
osascript -e "display notification \"Weekly learn failed (log: $state/$day.err)\" with title \"Weekly learn\""
exit 1
