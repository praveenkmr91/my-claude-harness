---
description: Audit entire repo for over-engineering — ranked delete-list, biggest cut first
---
<!-- vendored from ponytail v4.8.4, lean section adapted from ponytail-audit v5.3.2 (github.com/DietrichGebert/ponytail) — re-check upstream at the next curation sweep -->

Audit the entire repository for over-engineering only, not correctness. Scan the whole tree, not a diff. One line per finding, ranked biggest cut first: `<tag> <what to cut>. <replacement>. [path]`

Tags:
- `delete` — dead code / speculative feature
- `stdlib` — reinvented standard library
- `native` — dependency doing what the platform does
- `yagni` — abstraction with one implementation
- `shrink` — same logic, fewer lines
- `merge` — near-copies that must change together
- `split` — one function doing several unrelated jobs; split by job, never by length

A `shortcut:` comment naming its limit is a decision, not a finding, unless the expected load crosses it.

End with the net lines and dependencies removable. If nothing to cut: "Lean already. Ship."
