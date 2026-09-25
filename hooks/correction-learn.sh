#!/usr/bin/env bash
# UserPromptSubmit. Every failure path exits 0 — a non-zero exit eats the prompt.
# Phrases measured against 2489 real prompts (19/20 hits were corrections); `again`, bare `why do u` and `no,` were noise — re-measure before widening.
IN=$(cat)
P=$(jq -r '.prompt // ""' <<<"$IN")
case "$P" in *'<task-notification>'*|*'[SYSTEM NOTIFICATION'*) exit 0;; esac
REPEATED='\btold (you|u)\b|\bmany times\b|\bi (already )?said\b|\bwhy (do|did) (u|you) keep\b|\bkeep missing\b|\bwrong with (u|you)\b|\bi (didn.?t|did not|never) (approve|ask)|\b(u|you)\W+(\w+\W+)?stupid\b|\bstupid\W*$'
# "as i said" is a reiteration, not a correction — strip it before matching "i said".
WITHOUT_REITERATION=$(sed -E 's/[Aa][Ss] [Ii] ([Aa]lready )?[Ss]aid//g' <<<"$P")
grep -qiE "$REPEATED" <<<"$WITHOUT_REITERATION" || exit 0
echo "<correction-learn>This prompt corrects something already said. Fix it first. Then, before ending the turn, run /learn on this one correction — Absorb into the rule that let it happen by default, write only on the user's yes. Skip if this session already ran /learn on the same lesson.</correction-learn>"
exit 0
