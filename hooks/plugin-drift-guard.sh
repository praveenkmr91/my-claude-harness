#!/usr/bin/env bash
# Warns (never blocks) when enabledPlugins drifts from the blessed snapshot.
# Bless a deliberate change: bash ~/.claude/hooks/plugin-drift-guard.sh --accept
# Decision log: ~/.claude/plugin-curation.md
SETTINGS="$HOME/.claude/settings.json"
SNAPSHOT="$HOME/.claude/plugin-curation.expected.json"

LIVE=$(jq -S '.enabledPlugins // {}' "$SETTINGS" 2>/dev/null) || exit 0

if [ "$1" = "--accept" ] || [ ! -f "$SNAPSHOT" ]; then
  printf '%s\n' "$LIVE" > "$SNAPSHOT"
  [ "$1" = "--accept" ] && echo "plugin-drift-guard: snapshot blessed. Log the why in ~/.claude/plugin-curation.md."
  exit 0
fi

if [ "$LIVE" != "$(cat "$SNAPSHOT")" ]; then
  CHANGES=$(diff <(cat "$SNAPSHOT") <(printf '%s\n' "$LIVE") | grep -E '^[<>]' | sed 's/^</  expected:/; s/^>/  live:    /')
  BANNER="⚠ PLUGIN DRIFT — enabledPlugins no longer matches the blessed snapshot:
$CHANGES
Deliberate → bless it: bash ~/.claude/hooks/plugin-drift-guard.sh --accept (then log why in ~/.claude/plugin-curation.md).
Not deliberate → a plugin update/reinstall flipped it; check installed_plugins.json timestamps, see plugin-curation.md."
  # systemMessage → shown to the user in the UI; additionalContext → injected for the model. Both channels on purpose.
  jq -n --arg b "$BANNER" '{systemMessage: $b, hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $b}}'
fi
