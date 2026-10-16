# Harness backlog

Measured harness friction, parked. One entry per item: the evidence, why it is not fixed yet, the fix, and what makes it worth doing. An entry leaves this file in the commit that fixes it. Evidence comes from the 2026-10-05 transcript census (81 sessions in the OCBC RoboInvest project, 2026-09-13 to 2026-10-05); re-run a census before acting on a count older than a month. The full report, raw rows and re-run scripts are archived in `state/census/2026-10-05.tar.gz` (untracked; read with `tar -xzOf ~/.claude/state/census/2026-10-05.tar.gz census/report.md`, re-run `census/extract.js` then `census/report.js`).

## Open

### commit-trailer-check.sh reads the wrong commit in two shapes (2026-10-16)

- **Evidence:** the hook reads `git log -1` in the command's `git -C` dir or the session cwd. A `git commit` that exits 0 without committing re-reads the previous HEAD, so an older trailer there blocks an unrelated turn; `cd dir && git commit`, `git -c k=v -C dir commit` and a relative `-C` path are read against the session cwd, so a trailer in `dir` is missed.
- **Why parked:** neither shape has occurred; the first needs an older trailer already in HEAD, the second only misses (never blocks wrongly).
- **Fix:** record `git rev-parse HEAD` in a PreToolUse twin and skip when it is unchanged; resolve `cd <dir> &&` and any `-C` position, relative to the hook input's `cwd`.

### Skill and agent files are not linted against their tool grants (2026-10-16)

- **Evidence:** HERA (`hera/.claude/skills/_shared/scripts/check_skill_tool_grants.py`) fails a skill whose body says to run a script or invoke a skill without the matching tool, because the model improvises and reports compliance. `tests/harness.test.js` checks only `name` and `description` presence.
- **Why parked:** no drift seen yet in `agents/*.md` or the custom skills; a linter without a defect behind it gets ignored.
- **Fix:** one test over `agents/*.md` and `skills/*/SKILL.md`: name equals directory, description carries a "Use when" trigger, and a body naming `Skill(`, `Bash` or `AskUserQuestion` has the tool in `tools:` / `allowed-tools:` (AskUserQuestion in an agent body is always a fail). Advisory, with an allowlist.

### Existing hook tests lack quiet-twin and empty-input cases (2026-10-16)

- **Evidence:** `harness.md` now requires both (from HERA's two guards that never ran), applied to a hook when next touched. Untested so far for empty input: `plan-lint.js`, `comment-delta-check.js`, `new-dep-gate.js`.
- **Why parked:** the rule applies on touch; a retro-audit of every hook has no failure behind it yet.
- **Fix:** per hook, feed `{}`, a missing transcript and an unmatched command, and assert the documented fail-open or fail-closed outcome.

### Fable write-block is blind to shell writes (2026-10-14)

- **Evidence:** `opus-write-nudge.sh pre` blocks Write|Edit of source files from a Fable session, but `bash-write-guard.js` deliberately passes `sed -i`, `git mv` and `.bak` restores, so a Fable main thread can still edit source from Bash.
- **Why parked:** closing it means teaching the Bash guard the session model, and `sed -i` on source is also a legitimate Opus path; needs one rule for both hooks, not a second guard.
- **Fix:** in `bash-write-guard.js`, read the live model the same way the nudge does and deny `sed -i` / `perl -pi` on source extensions from a Fable session with the same message.

### Workers write source through interpreter scripts, unseen by write-time hooks (2026-10-14)

- **Evidence:** four `implementer` hand-backs today said "I made the edits with a Python script, because the session was in auto mode and told me to use Bash for changes." `bash-write-guard.js` denies heredocs and inline interpreters, but a script file run from the scratchpad has no visible target, so comment-check, plan-lint and the Fable write-block never fired.
- **Why parked:** the agent definition now forbids it (`agents/implementer.md`), which fixes the common case; a mechanical guard needs a target-blind signal. `external-io` and `general-purpose` carry the same Bash-plus-Write shape.
- **Fix:** a PostToolUse Bash hook for workers that diffs the tree before and after an interpreter invocation (`python|node|bun … <file>`) and flags source files that changed, pointing at the Edit tool; or deny running a script that lives under the scratchpad against a repo cwd.

### Fable write-block catches scratchpad probe files (2026-10-14)

- **Evidence:** writing a throwaway `vitest.nosetup.config.ts` into the session scratchpad was denied as a source write; an `implementer` had to create a measurement probe.
- **Why parked:** the extension gate in `opus-write-nudge.sh` has no notion of where a file lives; exempting a path needs the scratchpad root, which only the session knows (`CLAUDE_SCRATCHPAD`-style env or the `/private/tmp/claude-<uid>/` prefix).
- **Fix:** in the `pre` arm, exit 0 when `file_path` starts with the session scratchpad prefix; a probe is not shipped code.

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
