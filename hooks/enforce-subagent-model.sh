#!/bin/bash
# PreToolUse hook on Agent: keep each dispatch on the tier its work KIND earns —
# fable(4) > opus(3) > sonnet(2) > haiku(1).
# Policy: ~/.claude/subagent-tiers.md.
# Escapes: "fork" (inherits parent); "[tier-override: <why>]" in the prompt — which lifts
# every gate here EXCEPT a worker reaching for fable and a dispatch with no subagent_type.
# Session model = last assistant .message.model in transcript_path (tracks live
# /model switches, unlike settings.json). Fail-open on malformed input, unreadable
# transcript, or unknown session model — EXCEPT fable, which fails closed.

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

[ -z "$subagent_type" ] && deny 'Name the agent: a dispatch with no `subagent_type` silently becomes `general-purpose`, and a review fan-out or audit flavor is a `fork` (review-routing.md). Pick an agent from ~/.claude/agents/ or a plugin, or name `general-purpose` or `fork`.'

inject() {
  echo "$input" | jq --arg m "$1" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":(.tool_input + {model:$m})}}'
  exit 0
}

rank() {
  case "$1" in
    *fable*)  echo 4 ;;
    *opus*)   echo 3 ;;
    *sonnet*) echo 2 ;;
    *haiku*)  echo 1 ;;
    *)        echo 0 ;;
  esac
}

declares_own_model() {
  local definition="$HOME/.claude/agents/$1.md"
  [ -r "$definition" ] || return 1
  local declared
  declared=$(awk '
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    /^model:/ { sub(/^model:[ \t]*/, ""); gsub(/[ \t\r"\047]/, ""); print; exit }
  ' "$definition")
  [ -n "$declared" ] && [ "$declared" != "inherit" ]
}

session_model=""
fable_asked=false
sonnet_battery_asked=false
if [ -n "$transcript" ] && [ -r "$transcript" ]; then
  # -R + fromjson?: tolerate the partial first line a byte-offset tail can produce.
  tail_slice=$(tail -c 200000 "$transcript" 2>/dev/null)
  session_model=$(echo "$tail_slice" \
    | jq -rR 'fromjson? | select(.type? == "assistant") | .message.model // empty' 2>/dev/null \
    | tail -1)
  # Fable reviews code only on the user's say-so: the last typed turn contains a reserved
  # bigram — "fable review", "fable battery" / "battery (on) fable", "fable consult",
  # "fable opinion", "consult fable" / "opinion fable", "reviewed / checked by fable", "ask / get fable to
  # review", or "have / let fable review" (any case; the trailing \b keeps a report like
  # "fable reviewed it" from reading as an ask) — or it approves a reply BEFORE it that
  # carries the proposal phrase "Fable review?" / "Fable battery?". Anything looser
  # misfired on 2026-10-14: a heads-up saying "Fable-review gate" and a "yes" to an
  # unrelated question each opened the gate. The current turn's own text comes after that
  # turn, so the dispatcher cannot self-attest. tool_result turns are also type=user, so
  # only text content counts. Whole file, not the tail slice: a few big tool results push
  # the last typed turn past 200 KB. ~0.35 s on a 27 MB transcript.
  # Typed-turn filter from hooks/lib/turns.jq: isMeta turns, compaction summaries and
  # "<…>"-leading text are stored as user turns, not something Praveen typed.
  turns=$(jq -L "$(dirname "${BASH_SOURCE[0]}")/lib" -cR -n 'include "turns";
        [inputs | fromjson? | {type: "user", text: typed_text}, {type: "assistant", text: assistant_text}]' "$transcript" 2>/dev/null)
  last_user_text=$(echo "$turns" | jq -r 'map(select(.type == "user")) | last | .text // empty' 2>/dev/null)
  proposal_text=$(echo "$turns" | jq -r '(map(.type == "user") | rindex(true)) as $i
        | if $i == null then empty else .[:$i] | map(select(.type == "assistant")) | last | .text // empty end' 2>/dev/null)
  if printf '%s' "$last_user_text" | grep -Eiq 'fable (review|battery|consult|opinion)\b|battery (on |with |using )?fable\b|(consult|opinion) fable\b|(review(ed)?|check(ed)?) by fable\b|(ask|get) fable to (review|check)\b|(have|let) fable (review|check)\b'; then
    fable_asked=true
  fi
  if [ "$fable_asked" != true ] && [ -n "$proposal_text" ] \
      && printf '%s' "$proposal_text" | grep -Eq '[Ff]able (review|battery)\?' \
      && printf '%s' "$last_user_text" | grep -Eiq '^[[:space:]]*(y|yes|yep|yeah|ok|okay|sure|go|go ahead|do it|apply|approved|proceed)\b'; then
    fable_asked=true
  fi
  # A cheap battery is typed only, never proposed: no yes-to-a-proposal path.
  if printf '%s' "$last_user_text" | grep -Eiq 'sonnet battery\b|battery (on |with |using )?sonnet\b'; then
    sonnet_battery_asked=true
  fi
fi
session_rank=$(rank "$session_model")

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
  Plan|*review*|*analyzer*|*simplifier*|*silent-failure*|*adversarial*|*cold-reader*) is_brain_agent=true ;;
esac

if [ "$override" != "true" ]; then
  # A Sonnet or Haiku verdict on code is not an oracle, unless the user typed for a Sonnet battery.
  if [ "$is_brain_agent" = true ]; then
    below_tier="\"$subagent_type\" is review/planning work: it runs on opus (~/.claude/subagent-tiers.md). Pass model \"opus\", or omit model to have this hook place it."
    case "$child_model" in
      *sonnet*) { [ "$sonnet_battery_asked" = true ] && [ "$subagent_type" != "Plan" ]; } || deny "$below_tier" ;;
      *haiku*) deny "$below_tier" ;;
    esac
  fi
  # Fable reviews a plan. Exact match only: a glob here would hand the costliest tier to
  # any future agent whose name merely contains "plan".
  case "$child_model" in
    *fable*)
      if [ "$subagent_type" != "Plan" ] && ! { [ "$is_brain_agent" = true ] && [ "$fable_asked" = true ]; }; then
        deny "Fable is reserved for reviewing a PLAN, or for code review the user asked for by name in their last message (~/.claude/subagent-tiers.md); \"$subagent_type\" is neither. Code writing is never Fable's. Dispatch the consult as Plan, ask the user for a Fable review, or add \"[tier-override: <why>]\" to the prompt."
      fi ;;
  esac
fi

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
  # A Fable session does not hand its review agents Fable by inheritance; that takes the ask.
  if [ "$is_brain_agent" = true ] && [ "$session_rank" -eq 4 ] && [ "$fable_asked" != true ]; then
    inject "opus"
  fi
  # Fable never writes code: a general-purpose dispatch, or a worker whose definition names no
  # model, is placed on opus rather than inheriting (the /simplify skill fans out
  # general-purpose). An injected model would override the agent's own, so a worker whose
  # definition declares one (implementer, checker) is left alone.
  if [ "$is_brain_agent" != true ] && [ "$session_rank" -eq 4 ] && ! declares_own_model "$subagent_type"; then
    inject "opus"
  fi
  # A bare general-purpose dispatch from an Opus session inherited Opus for a settled-design
  # spike and its mechanical reruns (2026-10-25, ~158k tokens). Naming the model forces the
  # choice; opus stays allowed when named, for work whose design is still open.
  if [ "$subagent_type" = "general-purpose" ] && [ "$session_rank" -eq 3 ] && [ "$override" != "true" ]; then
    deny 'A `general-purpose` dispatch with no `model` inherits Opus from this session (~/.claude/subagent-tiers.md). Settled edits, rebases and spikes on a decided design go to `implementer` (Sonnet); reruns, counts and named checks to `checker` (Haiku). Pass `model: "opus"` only when the brief carries a design call that is still open, and name that call in the prompt.'
  fi
  exit 0
fi

[ "$override" = "true" ] && exit 0

# Fable decides here and returns: it is the one sanctioned step above the session tier, so
# falling through would hit the generic escalation cap below and deny it. Fails closed on an
# unknown session tier, unlike that cap.
case "$child_model" in
  *fable*)
    [ "$session_rank" -ge 3 ] && exit 0
    if [ "$session_rank" -eq 0 ]; then
      deny "Fable needs a confirmed Opus session and this session's model could not be read from the transcript (~/.claude/subagent-tiers.md). Re-dispatch from an Opus session, or add \"[tier-override: <why>]\" to the prompt."
    fi
    deny "Fable may only be dispatched from an Opus session (~/.claude/subagent-tiers.md); this session is $session_model. Pick opus, or add \"[tier-override: <why>]\" to the prompt."
    ;;
esac

[ "$session_rank" -eq 0 ] && exit 0

child_rank=$(rank "$child_model")

# Naming opus for a brain agent is the dispatch the omitted-model path already places.
[ "$is_brain_agent" = true ] && [ "$child_rank" -eq 3 ] && exit 0

if [ "$child_rank" -gt "$session_rank" ]; then
  jq -n --arg reason "Subagent model \"$child_model\" is above the session tier ($session_model). Omit model to inherit the session tier, or pick a lower one. If escalation is genuinely warranted, justify it in the prompt with a line \"[tier-override: <why>]\" and re-dispatch." \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
fi

exit 0
