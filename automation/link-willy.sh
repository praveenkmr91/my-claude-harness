#!/usr/bin/env bash
# Mirrors ~/.claude into the claude-switch profile ~/.claude-willy so a session there behaves as the main account.
# Rerun after adding a new top-level item to ~/.claude; existing links are left alone.
set -euo pipefail

MAIN="$HOME/.claude"
W="$HOME/.claude-willy"
BK="${TMPDIR:-/tmp}/willy-pre-link-$(date +%Y%m%d%H%M%S)"

# Per-account: org policy, remote settings, auth state, usage stats, .claude.json backups and caches.
SKIP=" .git .gitignore .DS_Store backups cache policy-limits.json policy-limits.json.stamp.json remote-settings.json remote-settings.json.synced-at daemon-auth-status.json daemon-auth-cooldown stats-cache.json "

mkdir -p "$BK"
for p in "$MAIN"/* "$MAIN"/.[!.]*; do
  n=$(basename "$p")
  case "$SKIP" in *" $n "*) continue ;; esac
  if [ -L "$W/$n" ] && [ "$(readlink "$W/$n")" = "$p" ]; then continue; fi
  if [ -e "$W/$n" ] || [ -L "$W/$n" ]; then mv "$W/$n" "$BK/"; fi
  ln -s "$p" "$W/$n"
done

# User-scope MCP servers live in .claude.json, which stays per-account.
CLAUDE_CONFIG_DIR="$W" claude mcp get chrome-devtools >/dev/null 2>&1 \
  || CLAUDE_CONFIG_DIR="$W" claude mcp add -s user chrome-devtools -- npx -y chrome-devtools-mcp@latest --isolated

echo "Moved aside to $BK: $(ls -A "$BK" | tr '\n' ' ')"
echo "Kept per-account: $(find "$W" -maxdepth 1 -mindepth 1 ! -type l -exec basename {} \; | tr '\n' ' ')"
