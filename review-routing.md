<review-routing>
- Six verbs are the only entry points; everything else is a lens a verb pulls in.
- Default ask is **review**; the hook's `<review-joins>` line picks verb + lenses — load exactly those.
- A named verb overrides the hook's `verb=`; its `lenses=` still ride along.
- Announce the pass in one line, then do it — main thread, session tier, unless the verb says otherwise.

| Verb | Members | Runs as |
|---|---|---|
| **review** — also "code review", "check this", "look over", or no verb | Me + reuse-analyzer and placement-analyzer lenses by hand | Main thread; every finding verified at source; never the battery |
| **battery** — also "full review", "deep review", "thorough review", "agents" | The battery in `~/.claude/review-battery.md`: seven, plus pr-test-analyzer when a test runner exists (Read it only on this verb) | Agents; leads confirmed at source before relaying. "Necessary"/"which" → propose members + reasons, await yes |
| **harden** — also "security review", "find bugs", "bug hunt", "adversarial", "break it" | adversarial-reviewer + security-review skills (main thread) | Cheap escalation for a hot path; joins battery on HIGH risk |
| **trim** — also "simplify", "simplifier", "modernise", "modern", "comments", "de-vibe", "clean up", "tidy" | /delete-list, /simplify, comment-analyzer, modern-ts-analyzer, /shortcut-debt | Quality only, no bug hunt |
| **audit** — bare = all, or `bloat` \| `a11y` \| `arch` \| `perf` | /delete-audit; a11y-audit; improve-codebase-architecture; web-quality-audit / core-web-vitals | Whole repo. Bare: fork per flavor, one ranked report; arch skips grilling; then `hooks/audit-due.sh --stamp`. Security → harden |
| **verify** — also any "done / ready to ship" claim | verification-before-completion → runtime replay of the ticket's worked example → advisor if irreversible (lint + tsc is the every-change gate in CLAUDE.md, not a verify member) | Before agreeing anything is done; `hooks/done-claim-gate.sh` enforces |

Hook joins (scope = files this session edited; dirty tree only when none):
- React files → react-best-practices; a finding needs a named rule id; no generic "could be slow".
- Styled files → /impeccable pass, named in the plan line.
- HIGH-risk path or an ask naming shared state / public API / money-moving mutation → adversarial-reviewer + security-review; with bulk, + code-reviewer.
- Bulk (≥200 added lines or ≥3 new files) → /delete-list (report, never auto-apply).
- Added web code → one lens per signal (fallbacks, new types, comments, legacy idioms, untested source); patterns in `hooks/review-classify.sh`.
- a11y-audit never auto-joins; write-time a11y (CLAUDE.md) still applies.
- Per joined lens: hand pass first (Read its definition: `~/.claude/agents/` or `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/pr-review-toolkit/agents/`), agent only on a lead. Reply carries one line per lens: `<lens>: N findings` or `<lens>: skip — <reason>`.
- PR ask ("check PR", "review PR 12", a PR URL; joins show `pr=`) → the `code-review` skill on that PR, lenses scored from its diff. `--comment` only on explicit ask; the battery (`pr-review-toolkit:review-pr`) only on full / deep.
- Auto: code edits nudge the lens list mid-turn; the Stop gate blocks a code turn's done-claim or commit ask until every named lens has its line.

Explicit ask only: grilling (stress-test a plan), systematic-debugging (bug survived two hypotheses). Explore locates code, never judges it.

Done bar scales; never cite a bigger tier's bar on smaller work. Trivial → lint + tsc. Small → + affected specs + lens hand pass. Big (plan-driven or bulk) → two review rounds over fresh diffs + battery, trim, harden once.

Findings:
- Score 0-100 before reporting. Pre-existing / linter-catchable / stylistic-not-in-CLAUDE.md / nitpick → 0-50; real defect with a concrete failure scenario → 75-100.
- Report ≥75 only; one line "N findings below threshold suppressed".
- Each finding = observation, impact, suggestion.
- Pre-existing debt: Critical (incident or security path) → report, tag pre-existing, never silently fix; High (blocks current work / recurs weekly) → one line; Medium/Low → suppressed count.
- Refactor recommendation needs a trigger (region touched 3+ times for bugs, 3+ duplicates, >3 mocks to test, planned work depends on it) and a behavioral-equivalence check; ugly-but-correct outside the change path → leave, say so.
</review-routing>
