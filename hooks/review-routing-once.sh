#!/usr/bin/env bash
# UserPromptSubmit. Every failure path exits 0 — a non-zero exit eats the prompt.
IN=$(cat)
P=$(jq -r '.prompt // ""' <<<"$IN")
case "$P" in *'<task-notification>'*|*'[SYSTEM NOTIFICATION'*|*'<agent-message'*) exit 0;; esac
grep -qiE '\b(review|audit|de-?vibe|modern|simplif|comments|clean ?up|tidy|verif|harden|trim|battery|agents|security|find (the |any )?bugs?|bug ?hunt|adversarial|break it|look over|a11y|accessib|ready to (ship|commit|merge)|check (my|this|the|it)|check(ing)? (out |over )?(that |a )?(PR|pull request)s?\b|github\.com/[^ ]+/pull/[0-9]+|is (it|this) done|done\?)' <<<"$P" || exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
FLAG="/tmp/claude-review-routing-$SID"
if [ -n "$SID" ] && [ -e "$FLAG" ]; then
  echo "<review-routing>applies (injected earlier this session; re-Read ~/.claude/review-routing.md if it scrolled out of context). Announce the chosen pass in one line, then do it.</review-routing>"
else
  cat "$HOME/.claude/review-routing.md"
fi

bash "$(dirname "$0")/review-classify.sh" <<<"$IN"
# Latch last: a timeout kill drops all output, so an early flag would hide the doc all session.
[ -n "$SID" ] && touch "$FLAG"
exit 0
