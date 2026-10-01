#!/bin/bash

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

DANGEROUS_PATTERNS=(
  "git push"
  "git reset --hard"
  "git clean -fd"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
  "push --force"
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

ARG='("[^"]*"|'\''[^'\'']*'\''|[^[:space:]]+)'
GIT_COMMIT='\bgit([[:space:]]+(-[Cc]|--git-dir|--work-tree|--namespace|--config-env)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+commit\b'
GH_PR='\bgh([[:space:]]+(-R|--repo)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+pr[[:space:]]+'
TMP_DIR='["'\'']?(/private)?/(tmp|var/folders)/'

GUARDED=(
  '\bcp\b[^|;&]*node_modules/::Do not cp out of node_modules. Check package.json scripts for an eject/copy command first — a hand-copied file silently goes stale on the next install.'
  '\brm\b[^|;&]*(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)::Do not delete a lockfile to clean it. Regenerating re-pins every ^/~ range to today registry (silent toolchain drift). Remove the single stanza by hand, or run npm install --package-lock-only.'
  "$GIT_COMMIT"'[[:space:]]+(--all\b|-[a-z]*a[a-z]*\b)::Do not commit with -a/--all. Use an explicit pathspec (git commit --only <paths>) so unrelated in-flight work in the tree is left untouched.'
  'git add[[:space:]]+(-[a-zA-Z]*A[a-zA-Z]*\b|--all\b|\.(/)?([[:space:]]|$))::Do not bulk-stage. git add -A/--all/. sweeps unrelated in-flight work and untracked debris into the commit — stage explicit paths.'
  '\bgit\b[^|;&]*--no-verify\b::Do not pass --no-verify. husky/lint-staged are part of the verify gate; if a hook is genuinely broken, surface it to the user instead of skipping it.'
  '\bgrep\b[^|;&]*--(include|exclude|exclude-dir)=[^'\''"\\[:space:]]*[][*?]::Quote the glob: --include='\''*.tsx'\''. zsh expands an unquoted glob, finds no file named --include=…, and aborts with '\''no matches found'\'' before grep runs — the empty result is not evidence.'
)

for entry in "${GUARDED[@]}"; do
  pattern="${entry%%::*}"
  message="${entry#*::}"
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: $message" >&2
    exit 2
  fi
done

if echo "$COMMAND" | grep -qE "$GIT_COMMIT|${GH_PR}(create|edit)\b" \
  && echo "$COMMAND" | grep -qiE 'co-authored-by|generated with|🤖'; then
  echo "BLOCKED: attribution trailer in a commit/PR message. The user forbids Co-Authored-By, 'Generated with', and tool footers everywhere (~/.claude/CLAUDE.md). Rewrite the message without it — do not copy trailers from existing commits in git log." >&2
  exit 2
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
# Exempt on where the commit runs, never on a temp path anywhere in the command: `-F <scratchpad>/msg.txt` is the usual commit route.
if echo "$COMMAND" | grep -qE "$GIT_COMMIT|${GH_PR}create\b" \
  && ! echo "$CWD" | grep -qE "^$TMP_DIR" \
  && ! { [ "$(echo "$COMMAND" | wc -l)" -eq 1 ] && echo "$COMMAND" | grep -qE "^[[:space:]]*cd[[:space:]]+${TMP_DIR}[^;&|]*&&[^;|]*$GIT_COMMIT|\bgit[[:space:]]+-C[[:space:]]+${TMP_DIR}[^[:space:]]*([[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+commit\b"; }; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"Commit/PR needs your yes (CLAUDE.md: never commit without explicit approval)."}}'
fi

exit 0
