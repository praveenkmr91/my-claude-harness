---
description: Run a change through plan → test → implement → review → verify → remember → improve, each stage gating the next
argument-hint: "<ticket, task or plan path>"
---

Run `$ARGUMENTS` through the stages below in order. Each stage names its owner; follow the owner, do not improvise the stage. A stage that fails its exit condition blocks the next one. Announce each stage in one line as it starts.

1. **Plan** — owner: `~/.claude/plan-mode.md`. Exit: plan approved (Trivial-tier change per plan-mode.md → state approach in one line and continue).
2. **Test** — owner: `tdd` skill, logic only. Exit: RED seen for every behavioural step. No logic in scope → say so and skip.
3. **Implement** — owner: CLAUDE.md "Delegating" and the tier spec. Exit: RED tests green; lint and tsc clean.
4. **Review** — owner: `~/.claude/review-routing.md`, default verb. Exit: one line per lens.
5. **Verify** — owner: `verification-before-completion` skill. Exit: worked example replayed at runtime.
6. **Remember** — owner: `remember:remember` skill. Exit: state saved.
7. **Improve** — owner: `/learn`. Exit: verdict given.

Stop after verify and show the diff; commit only on an explicit yes.
