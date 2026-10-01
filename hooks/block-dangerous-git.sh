#!/bin/bash

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# shlex, not a regex strip: a regex swallows the real push in `echo "a -m "; git push`. $( or a backtick keeps the raw scan.
SCAN=$COMMAND
if echo "$COMMAND" | grep -qE -- '(^|[[:space:]])(-m|--message|--title|--body)([=[:space:]]|$)' && ! echo "$COMMAND" | grep -qE '\$\(|`'; then
  SCAN=$(python3 -c '
import shlex, sys
lex = shlex.shlex(sys.argv[1], posix=True, punctuation_chars=True)
lex.whitespace_split = True
lex.commenters = ""
try:
    toks = list(lex)
except ValueError:
    print(sys.argv[1]); sys.exit()
out, skip = [], False
for t in toks:
    if skip:
        skip = False
    elif t in ("-m", "--message", "--title", "--body"):
        out.append(t); skip = True
    else:
        out.append(t.split("=", 1)[0] if t.startswith(("--message=", "--title=", "--body=")) else t)
print(" ".join(out))
' "$COMMAND")
fi

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
  if echo "$SCAN" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

ARG='("[^"]*"|'\''[^'\'']*'\''|[^[:space:]]+)'
GIT_COMMIT='\bgit([[:space:]]+(-[Cc]|--git-dir|--work-tree|--namespace|--config-env)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+commit\b'
GH_PR='\bgh([[:space:]]+(-R|--repo)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+pr[[:space:]]+'

GUARDED=(
  '\bcp\b[^|;&]*node_modules/::Do not cp out of node_modules. Check package.json scripts for an eject/copy command first — a hand-copied file silently goes stale on the next install.'
  '\brm\b[^|;&]*(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)::Do not delete a lockfile to clean it. Regenerating re-pins every ^/~ range to today registry (silent toolchain drift). Remove the single stanza by hand, or run npm install --package-lock-only.'
  "$GIT_COMMIT"'[[:space:]]+(--all\b|-[a-z]*a[a-z]*\b)::Do not commit with -a/--all. Use an explicit pathspec (git commit --only <paths>) so unrelated in-flight work in the tree is left untouched.'
  'git add[[:space:]]+(-[a-zA-Z]*A[a-zA-Z]*\b|--all\b|\.(/)?([[:space:]]|$))::Do not bulk-stage. git add -A/--all/. sweeps unrelated in-flight work and untracked debris into the commit — stage explicit paths.'
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

if echo "$SCAN" | grep -qE '\bgit\b[^|;&]*--no-verify\b'; then
  echo "BLOCKED: Do not pass --no-verify. husky/lint-staged are part of the verify gate; if a hook is genuinely broken, surface it to the user instead of skipping it." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE "$GIT_COMMIT|${GH_PR}(create|edit)\b" \
  && echo "$COMMAND" | grep -qiE 'co-authored-by|generated with|🤖'; then
  echo "BLOCKED: attribution trailer in a commit/PR message. The user forbids Co-Authored-By, 'Generated with', and tool footers everywhere (~/.claude/CLAUDE.md). Rewrite the message without it — do not copy trailers from existing commits in git log." >&2
  exit 2
fi

if echo "$COMMAND" | grep -qE "${GH_PR}create\b"; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"A PR is published to others and needs your yes (CLAUDE.md: push and PR need a yes)."}}'
fi

exit 0
