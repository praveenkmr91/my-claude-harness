---
description: Harvest every `shortcut:` comment in the repo into a debt ledger — deliberate corners cut, with their upgrade triggers
---
<!-- adapted from ponytail-debt v5.3.2 (github.com/DietrichGebert/ponytail) — re-check upstream at the next curation sweep; our marker is `shortcut:` per code-craft.md -->

Collect every deliberate shortcut into one ledger so a deferral cannot quietly become permanent. Read-only; changes nothing.

Scan: `git grep --no-index --exclude-standard -nE '(^[[:space:]]*|//|#|/[*]|[*]|<!--) ?shortcut:' -- ':!*.md'`

One row per marker, grouped by file:
`<file>:<line> — <what was simplified>. ceiling: <limit named>. upgrade: <trigger to revisit>.`

A marker that names no upgrade path or trigger gets a `no-trigger` tag — those are the ones that rot. A marker on code that no longer exists or whose limitation has since been fixed gets `stale`.

A marker's comment is every line of the comment it sits in. `no-trigger` = none of `until|once|when|upgrade|revisit|lands?|replaced?|before` as a word in that comment.

End with `<N> markers, <M> no-trigger, <K> stale.` Nothing found: `No shortcut: debt. Clean ledger.`

Do not fix anything from this pass; the ledger is the deliverable. If asked to persist it, write `docs/SHORTCUT-DEBT.md`.
