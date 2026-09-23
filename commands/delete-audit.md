---
description: Audit entire repo for over-engineering — ranked delete-list, biggest cut first
---
<!-- vendored from ponytail v4.8.4 (github.com/DietrichGebert/ponytail) — re-check upstream at the next curation sweep -->

Audit the entire repository for over-engineering only, not correctness. Scan the whole tree, not a diff. One line per finding, ranked biggest cut first: `<tag> <what to cut>. <replacement>. [path]`

Tags:
- `delete` — dead code / speculative feature
- `stdlib` — reinvented standard library
- `native` — dependency doing what the platform does
- `yagni` — abstraction with one implementation
- `shrink` — same logic, fewer lines

End with the net lines and dependencies removable. If nothing to cut: "Lean already. Ship."
