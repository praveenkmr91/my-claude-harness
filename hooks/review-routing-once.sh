#!/usr/bin/env bash
# UserPromptSubmit. Every failure path exits 0 — a non-zero exit eats the prompt.
IN=$(cat)
P=$(jq -r '.prompt // ""' <<<"$IN")
case "$P" in *'<task-notification>'*|*'[SYSTEM NOTIFICATION'*) exit 0;; esac
grep -qiE '\b(review|audit|de-?vibe|moderni[sz]|simplif|verif|harden|trim|battery|full review|agents|a11y|accessib|ready to (ship|commit|merge)|check (my|this|the|it)|is (it|this) done|done\?)' <<<"$P" || exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
FLAG="/tmp/claude-review-routing-$SID"
if [ -n "$SID" ] && [ -e "$FLAG" ]; then
  echo "<review-routing>applies (injected earlier this session; re-Read ~/.claude/review-routing.md if it scrolled out of context). Announce the chosen pass in one line, then do it.</review-routing>"
else
  [ -n "$SID" ] && touch "$FLAG"
  cat "$HOME/.claude/review-routing.md"
fi

bash "$(dirname "$0")/review-classify.sh" <<<"$IN"
