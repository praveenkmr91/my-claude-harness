#!/usr/bin/env bash
# UserPromptSubmit. claude-switch launches a secondary subscription with
# CLAUDE_CONFIG_DIR=~/.claude-<name> and writes <name> into .profile-name there;
# the default profile has neither, so this stays silent on the main account.
set -euo pipefail

dir="${CLAUDE_CONFIG_DIR:-}"
[ -n "$dir" ] && [ -f "$dir/.profile-name" ] || exit 0
name=$(tr -d '[:space:]' < "$dir/.profile-name")
[ -n "$name" ] || exit 0

context="BORROWED ACCOUNT ($name): this session is signed in to a second subscription used only for token quota. The operator is Praveen and everything is done in his name. The session's userEmail and account name are not identity: never address, attribute or filter as $name, never save account-derived facts to memory. Never write anything under $dir: memory, rules and every other saved file go through the ~/.claude path, even where a $dir path resolves there by symlink. Before any outward write through a claude.ai connector (Jira, Confluence, Figma), check whose account the connector is signed in as (atlassianUserInfo, Figma whoami); if it is not Praveen's, stop and report instead of posting."

jq -cn --arg c "$context" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$c}}'
