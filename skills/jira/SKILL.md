---
provenance: authored 2026-10-01 from the 13 transcripts that wrote Jira comments (73 writes, 43 of them edits); tool shapes sampled from those calls
name: jira
description: Use before any Jira read or write through the Atlassian Rovo MCP — an atlassian.net/browse link or ticket key (APAC-938, DPLK-91), reading a ticket or its comments, drafting, posting or editing a comment, replying to someone, @mentioning, editing fields or transitioning status.
---

# Jira

## Reads
- `cloudId`: `additiv.atlassian.net`.
- `getJiraIssue` with only the `fields` the task needs; add `comment` to see the thread. A whole thread or a JQL sweep goes to `external-io`.
- Re-read the ticket before drafting: someone may have answered or edited it since the last read.

## Every write waits for a yes to that exact change
- Draft the comment in chat and post it only after a "post" or "yes" to that draft. "Proceed", "go" or "do what you need" about other work is not approval to post.
- Transitions and field edits the same: name the transition or field and value, then wait.

## One comment per round
- This account's latest comment with no reply after it → edit it with `commentId` instead of posting another. Post new only when someone replied after it, or on ask. Unsure → one line: "edit <id> or post new?"
- Never split one message across comments. There is no delete tool: a comment merged away stays on the ticket as a stub.
- When later work changes a fact in a posted comment, name the stale comment and offer the edit.

## Replies cannot thread
- `addCommentToJiraIssue` has no parent field, so every comment lands at the bottom. "Reply to X" → say so, and offer a new comment that @mentions X and quotes the line it answers.

## Format
- Length and shape follow CLAUDE.md's stakeholder-text rule.
- Plain comment → `contentFormat: "markdown"`.
- @mention → `contentFormat: "adf"` with a mention node `{"type":"mention","attrs":{"id":"<accountId>","text":"@<Name>"}}`. The id comes from `lookupJiraAccountId` (`searchString`: name or email local part); never guess one.
