#!/bin/bash
# PostToolUse on Bash: after a git commit, read the message that landed in HEAD and block on an attribution trailer.
# block-dangerous-git.sh only sees the typed command, so a message from -F <file>, -F -, an editor or
# --amend --no-edit slips past it. Fails open on a cwd that is not a repo: there is no commit to read.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Copied from block-dangerous-git.sh.
ARG='("[^"]*"|'\''[^'\'']*'\''|[^[:space:]]+)'
GIT_COMMIT='\bgit([[:space:]]+(-[Cc]|--git-dir|--work-tree|--namespace|--config-env)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+commit\b'

echo "$COMMAND" | grep -qE "$GIT_COMMIT" || exit 0

DIR=$(echo "$COMMAND" | grep -oE '\bgit[[:space:]]+-C[[:space:]]+'"$ARG" | head -1 \
  | sed -E 's/^git[[:space:]]+-C[[:space:]]+//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')
[ -n "$DIR" ] || DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -n "$DIR" ] || DIR=$PWD

git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1 || exit 0
MSG=$(git -C "$DIR" log -1 --format=%B 2>/dev/null)

if printf '%s\n' "$MSG" | perl -pe 's/co-authored-by:[^<"\n]*<[^>@\s]+\@additiv\.com>//gi' | grep -qiE 'co-authored-by|generated with|🤖'; then
  echo "BLOCKED: attribution trailer landed in HEAD's commit message. Rewrite it: git commit --amend (no --no-edit) and remove the Co-Authored-By / 'Generated with' / tool footer line (~/.claude/committing.md). A teammate's @additiv.com co-author is fine." >&2
  exit 2
fi

exit 0
