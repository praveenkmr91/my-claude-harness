#!/bin/bash
# PreToolUse hook on Agent: keep each dispatch on the tier its work KIND earns —
# fable(4) > opus(3) > sonnet(2) > haiku(1).
# Policy (~/.claude/subagent-tiers.md):
#   planning / code review / debugging -> opus, never sonnet or haiku;
#   code, docs or config to a plan      -> sonnet (the `implementer` agent);
#   no-judgment work, exploration       -> haiku (`checker`, `Explore`);
#   reviewing a PLAN                    -> fable, from an Opus main thread only.
# Fable never writes or rewrites code, and never reviews code — that is Opus work.
# A worker never reaches Fable at all, not even with a tier-override: it returns the
# question to the dispatcher, which owns the escalation call. One decision-maker per consult.
# Escapes: "fork" (inherits parent); "[tier-override: <why>]" in the prompt — which lifts
# every gate here EXCEPT a worker reaching for fable.
# Session model = last assistant .message.model in transcript_path (tracks live
# /model switches, unlike settings.json). Fail-open on malformed input, unreadable
# transcript, or unknown session model — EXCEPT fable, which fails closed: it is the
# costliest tier, so an unknown session tier must not be a way to reach it.

input=$(cat)

echo "$input" | jq -e . >/dev/null 2>&1 || exit 0

subagent_type=$(echo "$input" | jq -r '.tool_input.subagent_type // ""')
child_model=$(echo "$input" | jq -r '.tool_input.model // ""')
override=$(echo "$input" | jq -r '.tool_input.prompt // "" | test("\\[tier-override:") | tostring')
transcript=$(echo "$input" | jq -r '.transcript_path // ""')
agent_id=$(echo "$input" | jq -r '.agent_id // ""')

[ "$subagent_type" = "fork" ] && exit 0

deny() {
  jq -n --arg reason "$1" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
}

inject() {
  echo "$input" | jq --arg m "$1" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":(.tool_input + {model:$m})}}'
  exit 0
}

# Unconditional, and deliberately above the [tier-override:] escape: a worker carrying an
# inherited override tag must not inherit the right to escalate with it.
if [ -n "$agent_id" ]; then
  case "$child_model" in
    *fable*) deny "A subagent never dispatches fable (~/.claude/subagent-tiers.md). Do not retry and do not route around this: finish the work that does not depend on the consult, then end your turn with the question for the dispatcher — state the decision, the options you see and what you need ruled on. The dispatcher owns the escalation call." ;;
  esac
fi

# Agents that exercise judgment about code or a design: opus work.
is_brain_agent=false
case "$subagent_type" in
  Plan|*review*|*analyzer*|*simplifier*|*silent-failure*|*adversarial*) is_brain_agent=true ;;
esac

if [ "$override" != "true" ]; then
  # A Sonnet or Haiku verdict on code is not an oracle.
  if [ "$is_brain_agent" = true ]; then
    case "$child_model" in
      *sonnet*|*haiku*) deny "\"$subagent_type\" is review/planning work: it runs on opus (~/.claude/subagent-tiers.md). Pass model \"opus\", or omit model to have this hook place it." ;;
    esac
  fi
  # Fable reviews a plan. Exact match only: a glob here would hand the costliest tier to
  # any future agent whose name merely contains "plan".
  case "$child_model" in
    *fable*)
      [ "$subagent_type" = "Plan" ] || deny "Fable is reserved for reviewing a PLAN (~/.claude/subagent-tiers.md); \"$subagent_type\" is not the planning agent. Code review is Opus work and code writing is never Fable's. Dispatch the consult as Plan, or add \"[tier-override: <why>]\" to the prompt." ;;
  esac
fi

rank() {
  case "$1" in
    *fable*)  echo 4 ;;
    *opus*)   echo 3 ;;
    *sonnet*) echo 2 ;;
    *haiku*)  echo 1 ;;
    *)        echo 0 ;;
  esac
}

session_model=""
if [ -n "$transcript" ] && [ -r "$transcript" ]; then
  # -R + fromjson?: tolerate the partial first line a byte-offset tail can produce.
  session_model=$(tail -c 200000 "$transcript" 2>/dev/null \
    | jq -rR 'fromjson? | select(.type? == "assistant") | .message.model // empty' 2>/dev/null \
    | tail -1)
fi
session_rank=$(rank "$session_model")

# Model omitted: the hook places the dispatch rather than letting it inherit silently,
# because inheritance is where the tier policy leaked — an unqualified mechanical dispatch
# from an Opus session quietly cost Opus, and review from a Sonnet session quietly ran
# below tier. Only these two KINDS are inferable from subagent_type; anything else
# inherits, since a blind downgrade would put a code-writing worker below tier invisibly.
if [ -z "$child_model" ]; then
  [ "$subagent_type" = "Explore" ] && inject "haiku"
  if [ "$is_brain_agent" = true ] && [ "$session_rank" -ge 1 ] && [ "$session_rank" -le 2 ]; then
    inject "opus"
  fi
  exit 0
fi

[ "$override" = "true" ] && exit 0

# Fable decides here and returns: it is the one sanctioned step above the session tier, so
# falling through would hit the generic escalation cap below and deny it. Fails closed on an
# unknown session tier, unlike that cap.
case "$child_model" in
  *fable*)
    [ "$session_rank" -eq 3 ] && exit 0
    if [ "$session_rank" -eq 0 ]; then
      deny "Fable needs a confirmed Opus session and this session's model could not be read from the transcript (~/.claude/subagent-tiers.md). Re-dispatch from an Opus session, or add \"[tier-override: <why>]\" to the prompt."
    fi
    deny "Fable may only be dispatched from an Opus session (~/.claude/subagent-tiers.md); this session is $session_model. Pick opus, or add \"[tier-override: <why>]\" to the prompt."
    ;;
esac

[ "$session_rank" -eq 0 ] && exit 0

child_rank=$(rank "$child_model")

if [ "$child_rank" -gt "$session_rank" ]; then
  jq -n --arg reason "Subagent model \"$child_model\" is above the session tier ($session_model). Omit model to inherit the session tier, or pick a lower one. If escalation is genuinely warranted, justify it in the prompt with a line \"[tier-override: <why>]\" and re-dispatch." \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
fi

exit 0
