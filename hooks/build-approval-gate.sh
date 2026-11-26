#!/usr/bin/env bash
# Write|Edit and Agent PreToolUse hook: after a plans/*.md edit, blocks source writes and `implementer` dispatches until a typed prompt says implement / build / start.
# Once a plan is approved in this transcript, later edits to that same plan (as-built notes, review-fix folds) stay approved; a different plan needs its own word.
# Plans match by file name, so an approval follows a plan moved from ~/.claude/plans/ to the repo's docs/plans/.
# Hook and test files under ~/.claude/ are never gated, so a fix to this gate cannot deadlock behind it; nor is the session scratchpad, whose probes never ship.
# Approval = a clause that opens with the word ("implement", "yes, build it", "review plan and implement"), outside a question, with no not / don't / why / later / yet / until in that clause.
# A typed handoff to another session approves too: a named one ("follow session-A's instructions", "take instructions from project-x-2b"; the name is an identifier-shaped
# token, hyphen, underscore or digit, never a Jira key) or a pointed one ("follow other session instructions", "take instructions from peer session"), since with two sessions
# the peer is unambiguous and its address is already in the receiving session's context; a handoff that points at no session ("do what they say") stays blocked.
# Only typed_text counts, and a clause carrying <agent-message is dropped, so a message relayed from another session can never approve this session's build in the user's name.
# Third-person or descriptive mentions ("new session will implement", "start app", "only start is deployed") and a prompt that defers ("ask for my approval") never approve.
# Fails open (exit 0) on a subagent call, an unreadable transcript, no plan edit in the transcript, or an ungated target.
IN=$(exec cat)

[ -n "$(exec jq -r '.agent_id // empty' <<<"$IN")" ] && exit 0
F=$(exec jq -r '.tool_input.file_path // empty' <<<"$IN")
T=$(exec jq -r '.transcript_path // empty' <<<"$IN")
[ -r "$T" ] || exit 0

if [ -n "$F" ]; then
  grep -qE '/\.claude/(hooks|tests)/|^(/private)?/tmp/claude-[0-9]+/[^/]+/[^/]+/scratchpad/' <<<"$F" && exit 0
  grep -qE '\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py|csv)$|(^|/)package\.json$' <<<"$F" || exit 0
else
  [ "$(exec jq -r '.tool_input.subagent_type // empty' <<<"$IN")" = implementer ] || exit 0
fi

UNAPPROVED_PLAN=$(exec jq -L "$(exec dirname "${BASH_SOURCE[0]}")/lib" -nRr 'include "approval"; unapproved_plan' "$T" 2>/dev/null)
[ -n "$UNAPPROVED_PLAN" ] || exit 0

printf 'The plan %s was edited and no typed implement / build / start, or handoff to another session (`follow <session>\x27s instructions`, `take instructions from peer session`), has followed it. The word has to open an instruction (`implement`, `yes, implement chunk 2`); a question, a deferral (not / later / until I approve), a mention of someone else building or a handoff that points at no session does not count. Answer the open items, then wait for that word before writing source or dispatching `implementer`; once given, later edits to the same plan stay approved.\n' "$UNAPPROVED_PLAN" >&2
exit 2
