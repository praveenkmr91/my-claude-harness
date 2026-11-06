<review-routing>
- Six verbs are the only entry points; everything else is a lens a verb pulls in.
- Default ask is **review**; the hook's `<review-joins>` line picks verb + lenses — load exactly those. No `lenses=` on it → nothing in scope; the verb row's members apply.
- A named verb overrides the hook's `verb=`, the heavier of two (battery > harden > review); its `lenses=` still ride along.
- Announce the pass as `Pass: <verb>`, then do it — main thread, session tier, unless the verb says otherwise.
- Effort (`effort=` on the joins line, only when the ask states one; xhigh / max read as high) sets depth, never members, and overrides the per-lens and threshold rules below. **low** → only findings verified at source with a reproduced failure scenario. **medium** or unstated → as below. **high** → every joined lens dispatched as an agent; findings 60-74 reported too, tagged uncertain. A stated level also goes to the `code-review` skill on PR asks and sets each agent's dispatch `effort`, above or below its frontmatter.

| Verb | Members | Runs as |
|---|---|---|
| **review** — also "code review", "check this", "look over", or no verb | Me + reuse-analyzer and placement-analyzer lenses by hand | Main thread; every finding verified at source; never the battery |
| **battery** — also "batteries", "full review", "deep review", "thorough review", "agents" | `~/.claude/review-battery.md` | Agents. "Which" → propose members, await yes; "relevant" → pick from the diff, name skips |
| **harden** — also "security review", "find bugs", "bug hunt", "adversarial", "break it" | adversarial-reviewer agent + security-review skill | Cheap escalation for a hot path; joins battery on HIGH risk |
| **trim** — also "simplify", "simplifier", "modernise", "modern", "comments", "de-vibe", "clean up", "tidy" | /delete-list, /simplify, comment-analyzer, modern-ts-analyzer, /shortcut-debt | Quality only, no bug hunt |
| **audit** — bare = all, or `bloat` \| `a11y` \| `arch` \| `perf` | /delete-audit; a11y-audit; improve-codebase-architecture; web-quality-audit / core-web-vitals | Whole repo. Bare: fork per flavor, one ranked report; arch skips grilling; then `hooks/audit-due.sh --stamp`. Security → harden |
| **verify** — also any "done / ready to ship" claim | verification-before-completion → runtime replay of the ticket's worked example → advisor if irreversible. A done-claim on an implementer build or a shipping commit (it deletes `docs/plans/<slug>.md`) runs each lens as an agent or skill or declines it with a reason; a hand-written findings line does not count. Plus one `/learn` pass per build session, or `learn: skip — <reason>`. | Before agreeing anything is done; `hooks/done-claim-gate.sh` enforces |

Hook joins (scope = files this session edited; dirty tree only when none):
- React files → react-best-practices; a finding needs a named rule id; no generic "could be slow".
- Styled diff → `/impeccable audit <files>`; hand lines never count.
- Comment-only scope → comment-analyzer alone.
- HIGH-risk source path (no specs, mocks, docs) or an ask naming shared state / public API / money-moving mutation → adversarial-reviewer + security-review; with bulk, + code-reviewer.
- Bulk (≥200 added lines or ≥3 new files) → /delete-list (report, never auto-apply).
- Added web code → one lens per signal (fallbacks, new types, comments, legacy idioms, untested source); patterns in `hooks/review-classify.sh`.
- a11y-audit never auto-joins.
- Per joined lens: hand pass first, reading its definition in `~/.claude/agents/` or the pr-review-toolkit plugin's `agents/`; agent only on a lead. One reply line per lens: `<lens>: N findings` or `<lens>: skip — <reason>`.
- PR ask ("check PR", "review PR 12", a PR URL; joins show `pr=`) → the `code-review` skill on that PR, lenses scored from its diff. `--comment` only on explicit ask; the battery (`pr-review-toolkit:review-pr`) only on full / deep.
- Auto: code edits nudge the lens list mid-turn; the Stop gate blocks a code turn's done-claim or commit ask until every named lens has its line.

Explicit ask only: grilling (stress-test a plan), systematic-debugging (bug survived two hypotheses).

Done bar scales; never cite a bigger tier's bar on smaller work. Trivial → lint + tsc. Small, and each plan step → + affected specs + lens hand pass. Big (bulk or HIGH-risk) → two review rounds over fresh diffs + battery (unasked, members picked as on "relevant"), /delete-list (never /simplify: the battery covers it), harden once. The repo's full gate exiting non-zero blocks a ship claim even on a foreign or untracked file; members run one by one are not a pass; it runs in the push's checkout after a frozen install.

Findings:
- Score 0-100 before reporting. Pre-existing / linter-catchable / stylistic-not-in-CLAUDE.md / nitpick → 0-50; real defect with a concrete failure scenario → 75-100.
- Report ≥75 only; one line "N findings below threshold suppressed".
- Each finding = observation, impact, suggestion.
- Findings routed to a named peer session: every later recheck on that work goes there unasked.
- Pre-existing debt: Critical (incident or security path) → report, tag pre-existing, never silently fix; High (blocks current work / recurs weekly) → one line; Medium/Low → suppressed count.
- Refactor recommendation needs a trigger (region touched 3+ times for bugs, 3+ duplicates, >3 mocks to test, planned work depends on it) and a behavioral-equivalence check; ugly-but-correct outside the change path → leave, say so.
</review-routing>
