---
description: Review current diff for over-engineering only — output a delete-list
---
<!-- vendored from ponytail v4.8.4, lean section adapted from ponytail-review v5.3.2 (github.com/DietrichGebert/ponytail) — re-check upstream at the next curation sweep -->

Review the current code changes for over-engineering only, not correctness. One line per finding: `L<line>: <tag> <what to cut>. <replacement>.`

Tags:
- `delete` — dead code / speculative feature
- `stdlib` — reinvented standard library
- `native` — dependency doing what the platform does
- `yagni` — abstraction with one implementation
- `shrink` — same logic, fewer lines
- `merge` — near-copies that must change together
- `split` — one function doing several unrelated jobs; split by job, never by length

A `shortcut:` comment naming its limit is a decision, not a finding, unless the expected load crosses it.

End with the net lines removable. If nothing to cut: "Lean already. Ship."
