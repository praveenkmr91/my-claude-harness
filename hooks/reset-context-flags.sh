#!/usr/bin/env bash
SID=$(jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0

# Nudge counters (review-lenses-*, inline-calls-*) track work done, not context, so compaction must not reset them.
rm -f "/tmp/claude-docs-ctx-$SID" \
  "/tmp/claude-hydrogen-ctx-$SID" \
  "/tmp/claude-plan-mode-$SID" \
  "/tmp/claude-review-routing-$SID" \
  "/tmp/claude-harness-ctx-$SID-"* \
  /tmp/claude-inject-*-"$SID"-*
