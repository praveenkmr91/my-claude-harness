#!/usr/bin/env bash
# SessionStart: show the newest weekly learn report until `/learn report` acknowledges it (touches state/learn/acked).
# The glob [0-9]*.md keeps digest files under state/learn/digest/ from counting as a report.
# Every failure path exits 0 silently.
IN=$(exec cat)
case "$(exec jq -r '.source // empty' <<<"$IN")" in startup|resume) ;; *) exit 0 ;; esac
DIR="$HOME/.claude/state/learn"
REPORT=$(ls -t "$DIR"/[0-9]*.md 2>/dev/null | head -1)
[ -n "$REPORT" ] && [ "$REPORT" -nt "$DIR/acked" ] || exit 0
N=$(exec grep -c '^## \(Absorb\|Save\)' "$REPORT")
jq -n --arg m "Weekly learn report $(exec basename "$REPORT" .md): $N proposals at $REPORT; run \`/learn report\`" '{systemMessage: $m}'
