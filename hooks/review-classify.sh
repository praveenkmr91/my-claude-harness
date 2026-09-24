#!/usr/bin/env bash
# Hook JSON on stdin, <review-joins> line out. done-claim-gate.sh parses verb= and lenses= — keep those keys.
IN=$(cat)
# Scope is the task, not the tree — code is often committed before the review.
TRANSCRIPT=$(jq -r '.transcript_path // empty' <<<"$IN")
EDITED=""; SINCE=""
if [ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ]; then
  EDITED=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and (.name|test("^(Write|Edit|MultiEdit)$"))) | .input.file_path // empty' "$TRANSCRIPT" 2>/dev/null)
  SINCE=$(jq -r 'select(.timestamp) | .timestamp' "$TRANSCRIPT" 2>/dev/null | head -1)
fi
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
COMMITTED=""; [ -n "$SINCE" ] && COMMITTED=$(git log --name-only --pretty=format: --since="$SINCE" 2>/dev/null)
FILES=$( { printf '%s\n' "$EDITED" "$COMMITTED"; git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sed '/^$/d' | sort -u)
[ -n "$FILES" ] || exit 0
REACT=no; grep -qE '\.(tsx|jsx)$|/use-[a-z0-9-]+\.ts$' <<<"$FILES" && REACT=yes
STYLED=no; grep -qE '\.(tsx|jsx|vue|css|scss|less)$' <<<"$FILES" && STYLED=yes
# Repo-agnostic on purpose; this runs in every repo. Whole-word match after a camelCase split —
# bare substrings flag author/, recorder.ts and design tokens, silently upgrading review to harden.
RISK=$(paste <(sed -E 's/([a-z0-9])([A-Z])/\1-\2/g' <<<"$FILES") <(printf '%s\n' "$FILES") \
  | awk -F'\t' -v re='(^|[^a-z0-9])(o?auth|authentic[a-z]*|authori[sz][a-z]*|session|tokens?|(re)?payments?|checkout|orders?|wallet)([^a-z0-9]|$)' \
        -v ex='design-tokens|tokens?\.(css|scss|less)$' '{l=tolower($1)} l ~ re && l !~ ex {print $2}' | head -5 | tr '\n' ' ')
# Bulk = over-engineering risk: added lines across committed-this-session + dirty + untracked, new files likewise.
ADDED=$( { [ -n "$SINCE" ] && git log --numstat --pretty=format: --since="$SINCE" 2>/dev/null; git diff --numstat HEAD 2>/dev/null; git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 wc -l 2>/dev/null | awk '$2!="total"{print $1"\t0\t"$2}'; } | awk '$1~/^[0-9]+$/{a+=$1} END{print a+0}')
NEWFILES=$( { [ -n "$SINCE" ] && git log --diff-filter=A --name-only --pretty=format: --since="$SINCE" 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sed '/^$/d' | sort -u | wc -l | tr -d ' ')
VERB=review; LENSES=reuse-analyzer,placement-analyzer
[ "$REACT" = yes ] && LENSES="$LENSES,react-best-practices"
[ "$STYLED" = yes ] && LENSES="$LENSES,impeccable"
[ -n "$RISK" ] && { VERB=harden; LENSES="$LENSES,adversarial-reviewer,security-review,silent-failure-hunter,type-design-analyzer"; }
BULK=no; { [ "$ADDED" -ge 200 ] || [ "$NEWFILES" -ge 3 ]; } && { BULK=yes; LENSES="$LENSES,delete-list,shortcut-debt,comment-analyzer,modern-ts-analyzer"; }
[ -n "$RISK" ] && [ "$BULK" = yes ] && VERB=battery
echo "<review-joins verb=$VERB lenses=$LENSES react=$REACT styled=$STYLED high-risk=${RISK:-none} bulk=$BULK added=$ADDED new-files=$NEWFILES>"
