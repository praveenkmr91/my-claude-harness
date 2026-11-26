#!/usr/bin/env bash
SID=$(exec jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0

rm -f "/tmp/claude-docs-ctx-$SID" \
  "/tmp/claude-hydrogen-ctx-$SID-"* \
  "/tmp/claude-plan-mode-$SID" \
  "/tmp/claude-plan-mode-$SID-"* \
  "/tmp/claude-review-routing-$SID" \
  "/tmp/claude-harness-ctx-$SID-"* \
  /tmp/claude-inject-*-"$SID"-*
