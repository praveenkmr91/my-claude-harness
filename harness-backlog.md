# Harness backlog

Measured harness friction, parked. One entry per item: the evidence, why it is not fixed yet, the fix, and what makes it worth doing. An entry leaves this file in the commit that fixes it. Evidence comes from the 2026-10-05 transcript census (81 sessions in the OCBC RoboInvest project, 2026-09-13 to 2026-10-05); re-run a census before acting on a count older than a month. The full report, raw rows and re-run scripts are archived in `state/census/2026-10-05.tar.gz` (untracked; read with `tar -xzOf ~/.claude/state/census/2026-10-05.tar.gz census/report.md`, re-run `census/extract.js` then `census/report.js`).

## Open

### Building or committing before the user approved (2026-10-05)

- **Evidence:** 27 user corrections in 19 sessions — "wait, i didnt approve plans. why are u implementing already?" (`41a910d0`, 2026-09-29), "yes. dont commit yet" (`0672921d`, 2026-10-02). The largest single correction theme.
- **Why parked:** a mechanical gate needs a reliable approval signal; "yes" answering a question, "go" on part of a plan, and "commit locally unasked" (committing.md) all blur it. Needs a design pass.
- **Fix:** a PreToolUse gate on Write|Edit of source files that blocks while a plan file written this session has no explicit approval prompt ("approve", "proceed", "go" on that plan) after its last write; reconcile with the commit-unasked rule.
- **Signal candidates (2026-10-11):** one reserved approval phrase the gate keys on, so a "yes" to some other question never unlocks it (the shape of RIPER-5's explicit execute mode and Launch Codes' one-time confirm code, both on claudemod.com), vs native `ExitPlanMode` approval. Pick one in the design pass.
- **Worth doing when:** next time this correction recurs, or before the next multi-step plan.

### Stop-gate block chains run long (2026-10-05)

- **Evidence:** "DONE-CLAIM WITHOUT EVIDENCE" averages 3.6 consecutive blocks per turn (longest 8, 12 sessions, e.g. `628b331c` 2026-10-04); "NAMED VERB NOT RUN" averages 2.7 (harden 28, battery 10, trim 7).
- **Why parked:** unknown whether the gate's condition is hard to satisfy or the model answers it wrongly; fixing blind risks loosening a real gate.
- **Fix:** read five of the longest chains, classify each block as gate-too-strict vs model-wrong, then adjust `hooks/done-claim-gate.sh` or its message accordingly.
- **Worth doing when:** a session loses three or more turns to one chain again.

### Review-lens verdict ceremony (2026-10-05)

- **Evidence:** 98 "REVIEW NOT RUN" Stop blocks in 32 sessions; 77 were answered with a text-only verdict line, not a review.
- **Why parked:** `92f388e` (2026-10-05) widened the accepted verdict forms, which may remove most of these; measure before changing more.
- **Fix:** if still high, prompt the verdict lines at the lens nudge instead of at Stop, or skip the gate for edits confined to `~/.claude`.
- **Worth doing when:** a census after 2026-10-19 still shows more than one block per code session.

### Write-guard sweep fallback still over-blocks (2026-10-05)

- **Evidence:** a write call whose destination is a plain variable or function parameter (not `process.argv`/`sys.argv`) falls back to sweeping every path-like token in the command, so mentioning source files blocks a scratch-only write. Seen once on 2026-10-05 after the argv fix (`8aef66f`).
- **Why parked:** loosening the fallback risks letting a real source write through; one sighting is not enough to pick the rule.
- **Fix:** resolve simple same-script assignments (`const out = process.argv[2]`, `out = sys.argv[1]`) the way `PY_STRING_ASSIGN` resolves literals.
- **Worth doing when:** it blocks a legitimate command twice more.

### Secrets hook matches words inside quoted text (2026-10-12)

- **Evidence:** the `env-dump` rule (`hooks/protect-secrets.js:115`) matches `\bprintenv\b` anywhere in the raw command, so a commit whose message only mentioned the word was denied on 2026-10-11 (session `9ef16fc6`). Same false-positive class `651d0f3` fixed in `block-dangerous-git.sh`.
- **Why parked:** one sighting, and rewording the message is a cheap way around it; tokenizing every rule in the hook is a larger change than the friction.
- **Fix:** match command words only, not quoted arguments — reuse the `shlex` segment scan from `block-dangerous-git.sh`, or anchor the rule to command position (`(?:^|[;&|]\s*)printenv\b`).
- **Worth doing when:** it denies a legitimate command twice more.
