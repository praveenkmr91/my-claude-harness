#!/bin/bash
# SubagentStop, report-only: no channel to the main thread. Reliable record = hooks-logs line; systemMessage display from SubagentStop is unconfirmed in the UI.
# shortcut: Bash edits (sed -i, heredocs) are not Write/Edit tool_use and are invisible here; upgrade = parse Bash tool_result changed-file lists.
# shortcut: any existing path in the brief counts as in scope, including one inside a "do not touch X" clause.

input=$(cat)
echo "$input" | jq -e . >/dev/null 2>&1 || exit 0

[ "$(echo "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

transcript=$(echo "$input" | jq -r '.agent_transcript_path // ""')
cwd=$(echo "$input" | jq -r '.cwd // ""')
agent_type=$(echo "$input" | jq -r '.agent_type // ""')
[ -r "$transcript" ] || exit 0

written=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | select(.name=="Write" or .name=="Edit" or .name=="NotebookEdit") | .input.file_path // .input.notebook_path // empty' "$transcript" | sort -u)
[ -z "$written" ] && exit 0

brief=$(jq -r 'select(.type=="user") | .message.content | if type=="string" then . else map(select(.type=="text")|.text)|join("\n") end' "$transcript" | head -c 20000)

absolutize() {
  case "$1" in
    /*) echo "$1" ;;
    *) echo "$cwd/${1#./}" ;;
  esac
}

expected=""
while IFS= read -r token; do
  [ -z "$token" ] && continue
  abs=$(absolutize "$token")
  [ -e "$abs" ] && expected+="$abs"$'\n'
done < <(echo "$brief" | grep -oE '(~|\.{1,2})?/?[A-Za-z0-9_@.-]+(/[A-Za-z0-9_@.-]*)+|[A-Za-z0-9_@-]+\.[a-z]{1,5}\b' | sed -e "s|^~|$HOME|" -e 's/\.*$//' | sort -u)

[ -z "$expected" ] && exit 0

in_scope() {
  local file="$1"
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    [ "$file" = "$path" ] && return 0
    [ -d "$path" ] && case "$file" in "${path%/}"/*) return 0 ;; esac
  done <<<"$expected"
  return 1
}

unlisted=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  in_scope "$file" || unlisted+="  $file"$'\n'
done <<<"$written"

[ -z "$unlisted" ] && exit 0

msg="Agent ($agent_type) wrote outside the files its brief named:"$'\n'"$unlisted""Review before trusting the hand-back; revert if not intended."
printf '{"ts":"%s","hook":"agent-file-scope","level":"WARN","session_id":"%s","agent_id":"%s","agent_type":"%s","cwd":"%s","unlisted":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(echo "$input" | jq -r '.session_id // ""')" "$(echo "$input" | jq -r '.agent_id // ""')" "$agent_type" "$cwd" \
  "$(printf '%s' "$unlisted" | sed 's/^  //' | jq -R . | jq -sc .)" >> "$HOME/.claude/hooks-logs/$(date +%Y-%m-%d).jsonl"
jq -n --arg m "$msg" '{"systemMessage": $m}'
exit 0
