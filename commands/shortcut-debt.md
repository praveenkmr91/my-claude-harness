---
description: Harvest every `shortcut:` comment in the repo into a debt ledger — deliberate corners cut, with their upgrade triggers
---
<!-- adapted from ponytail-debt v4.8.4 (github.com/DietrichGebert/ponytail); our marker is `shortcut:` per global CLAUDE.md -->

Collect every deliberate shortcut into one ledger so a deferral cannot quietly become permanent. Read-only; changes nothing.

Scan: `grep -rnE '(//|#|\{/\*|<!--|\*) ?shortcut:' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build`

One row per marker, grouped by file:
`<file>:<line> — <what was simplified>. ceiling: <limit named>. upgrade: <trigger to revisit>.`

A marker that names no upgrade path or trigger gets a `no-trigger` tag — those are the ones that rot. A marker on code that no longer exists or whose limitation has since been fixed gets `stale`.

End with `<N> markers, <M> no-trigger, <K> stale.` Nothing found: `No shortcut: debt. Clean ledger.`

Do not fix anything from this pass; the ledger is the deliverable. If asked to persist it, write `docs/SHORTCUT-DEBT.md`.
