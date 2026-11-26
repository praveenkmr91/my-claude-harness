#!/usr/bin/env bash
# Stop hook, mechanical arm of persona-core.md's model-switch line at the plan-to-build boundary.
# Fires when the session runs Fable, a plan is still unapproved (same oracle as build-approval-gate.sh) and the final reply's last two lines ask for the approval word, quoted or after type / say.
# Output is a systemMessage: shown to the user, never blocking and never a model turn, so the nudge no longer depends on the reply carrying it.
# Once per plan per session: a second ask for the same plan stays quiet, which is how an ignored nudge is dropped.
# Fails open (exit 0, silent) on a subagent, an unreadable transcript, an unknown model or no session id.
IN=$(exec cat)

[ -n "$(exec jq -r '.agent_id // empty' <<<"$IN" 2>/dev/null)" ] && exit 0
SID=$(exec jq -r '.session_id // empty' <<<"$IN" 2>/dev/null)
T=$(exec jq -r '.transcript_path // empty' <<<"$IN" 2>/dev/null)
[ -n "$SID" ] && [ -r "$T" ] || exit 0
LIB="$(exec dirname "${BASH_SOURCE[0]}")/lib"

MODEL=$(tail -c 200000 "$T" 2>/dev/null \
  | jq -rR 'fromjson? | select(.type? == "assistant") | .message.model // empty' 2>/dev/null | tail -1)
case "$MODEL" in *fable*) ;; *) exit 0 ;; esac

PLAN=$(exec jq -L "$LIB" -nRr 'include "approval"; unapproved_plan' "$T" 2>/dev/null)
[ -n "$PLAN" ] || exit 0

# Stop can fire before the final reply is flushed to the transcript, so the hook input's copy wins.
FINAL=$(exec jq -r '.last_assistant_message | strings' <<<"$IN" 2>/dev/null)
[ -n "$FINAL" ] || FINAL=$(exec jq -L "$LIB" -nrR 'include "turns"; [inputs | fromjson? | assistant_text] | last // empty' "$T" 2>/dev/null)
CLOSING=$(grep -v '^[[:space:]]*$' <<<"$FINAL" | tail -2)
# A quoted word or a type/say frame only: "before I implement" in prose would spend the one nudge early.
grep -qiE '["`“](implement|build|start)["`”]|\b(type|say)[^[:alnum:]]+(implement|build|start)\b' <<<"$CLOSING" || exit 0

PLAN_NAME=$(exec basename "$PLAN")
SEEN="$HOME/.claude/state/model-nudge/$SID"
grep -qxF "$PLAN_NAME" "$SEEN" 2>/dev/null && exit 0
mkdir -p "$(exec dirname "$SEEN")" && printf '%s\n' "$PLAN_NAME" >>"$SEEN"

jq -n --arg m "Plan $PLAN_NAME is waiting for approval and this session runs Fable. The build is Opus work: run /model opus, then type implement." '{systemMessage: $m}'
