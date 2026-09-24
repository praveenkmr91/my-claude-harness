<review-routing>
- Six verbs are the only entry points; everything else is a lens a verb pulls in.
- Default ask is **review**; the hook's `<review-joins>` line picks verb + lenses from the files the task touched — load exactly those.
- A named verb overrides the hook's `verb=`; its `lenses=` still ride along.
- Announce the pass in one line, then do it — main thread, session tier, unless the verb says otherwise.

| Verb | Members | Runs as |
|---|---|---|
| **review** — also "code review", "check this", "de-vibe", "modernise", or no verb | Me + reuse-analyzer and placement-analyzer lenses by hand (`~/.claude/agents/*-analyzer.md`) | Main thread; every finding verified at source; never the battery |
| **battery** — also "full review", "agents" | The battery in `~/.claude/review-battery.md`: seven, plus pr-test-analyzer when a test runner exists (Read only on this verb) | Agents; leads confirmed at source before relaying |
| **harden** | adversarial-reviewer + security-review skills (main thread); silent-failure-hunter + type-design-analyzer (agents) | Cheap escalation for a hot path; joins battery on HIGH risk |
| **trim** | /delete-list, /simplify, comment-analyzer, modern-ts-analyzer, /shortcut-debt | Quality only, no bug hunt |
| **audit** — bare = all, or `bloat` \| `a11y` \| `arch` \| `perf` | /delete-audit; a11y-audit; improve-codebase-architecture; web-quality-audit / core-web-vitals | Whole repo. Bare: fork per flavor, one ranked report; arch skips grilling; then `hooks/audit-due.sh --stamp`. Security → harden |
| **verify** — also any "done / ready to ship" claim | verification-before-completion → runtime replay of the ticket's worked example → advisor (lint + tsc is the every-change gate in CLAUDE.md, not a verify member) | Before agreeing anything is done; `hooks/done-claim-gate.sh` enforces |

Hook joins (scope = files the task edited or committed; dirty tree as fallback):
- React files → react-best-practices; a finding needs a named rule id; no generic "could be slow".
- Styled files → /impeccable pass, named in the plan line.
- HIGH-risk path (auth, session, token, payment, checkout, order, wallet) or an ask naming shared state / public API / money-moving mutation → harden set; with bulk → battery.
- Bulk (≥200 added lines or ≥3 new files) → trim set minus `/simplify` (report, never auto-apply): /delete-list, /shortcut-debt, comment-analyzer, modern-ts-analyzer.
- a11y-audit never auto-joins; write-time a11y (CLAUDE.md) still applies.
- Auto: the Stop gate blocks a code turn that claims done or asks to commit with no review pass; run the verb it names.

Explicit ask only: grilling (stress-test a plan), systematic-debugging (bug survived two hypotheses), advisor. Trivial change → lint + tsc. Explore locates code, never judges it.

Findings:
- Score 0-100 before reporting. Pre-existing / linter-catchable / stylistic-not-in-CLAUDE.md / nitpick → 0-50; real defect with a concrete failure scenario → 75-100.
- Report ≥75 only; one line "N findings below threshold suppressed".
- Each finding = observation, impact, suggestion.
- Pre-existing debt: Critical (incident or security path) → report, tag pre-existing, never silently fix; High (blocks current work / recurs weekly) → one line; Medium/Low → suppressed count.
- Refactor recommendation needs a trigger (region touched 3+ times for bugs, 3+ duplicates, >3 mocks to test, planned work depends on it) and a behavioral-equivalence check; ugly-but-correct outside the change path → leave, say so.
</review-routing>
