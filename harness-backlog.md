# Harness backlog

Measured harness friction, parked. One entry per item: the evidence, why it is not fixed yet, the fix, and what makes it worth doing. An entry leaves this file in the commit that fixes it. Counts come from a transcript census archived under `state/census/` (untracked; `tar -xzOf <archive> census/report.md`, re-run `census/extract.js` then `census/report.js`); re-run it before acting on a count older than a month.

## Open

### Same-file edit counter (thrash nudge)

- **Evidence:** 30-day census of main-thread Edit/Write on source files (2026-10-22, `edit-census-filtered.py` in that session's scratchpad): 88 of 1,428 (turn, file) pairs carry 5+ edits, across 52 of 166 editing sessions; 14 pairs carry 10+. The top rows are new hook scripts and spec files being built up, not visible thrash.
- **Why parked:** a nudge at 5 fires in a third of editing sessions, mostly on ordinary iteration; at 10 it would fire ~14 times a month on turns nobody has read yet. The `systematic-debugging` skill's trigger (two failed hypotheses) already names the real signal by rule.
- **Fix:** read five of the 10+ turns; if most are edit → failing test → edit loops, a PostToolUse Write|Edit hook (shape of `inline-call-nudge.sh`) counting per `(session, file)` since the last typed prompt, nudging once at 10 toward `systematic-debugging`. Idea from Claude Forge's `loop-detection.sh`.

### commit-trailer-check.sh reads the wrong commit in two shapes

- **Evidence:** the hook reads `git log -1` in the command's `git -C` dir or the session cwd. A `git commit` that exits 0 without committing re-reads the previous HEAD, so an older trailer there blocks an unrelated turn; `cd dir && git commit`, `git -c k=v -C dir commit` and a relative `-C` path are read against the session cwd, so a trailer in `dir` is missed.
- **Why parked:** neither shape has occurred; the first needs an older trailer already in HEAD, the second only misses (never blocks wrongly).
- **Fix:** record `git rev-parse HEAD` in a PreToolUse twin and skip when it is unchanged; resolve `cd <dir> &&` and any `-C` position, relative to the hook input's `cwd`.

### Existing hook tests lack quiet-twin and empty-input cases

- **Evidence:** `harness.md` requires both, applied to a hook when next touched. Untested so far for empty input: `new-dep-gate.js`.
- **Why parked:** the rule applies on touch; a retro-audit of every hook has no failure behind it yet.
- **Fix:** per hook, feed `{}`, a missing transcript and an unmatched command, and assert the documented fail-open or fail-closed outcome.

### Main-thread write-block is blind to shell writes

- **Evidence:** `opus-write-nudge.sh` blocks the first Write|Edit of a source file per turn from an Opus-or-above main thread, but `bash-write-guard.js` deliberately passes `sed -i`, `git mv` and `.bak` restores, so the same thread can still edit source from Bash.
- **Why parked:** closing it means teaching the Bash guard the session model and the hook's three escapes; needs one rule for both hooks, not a second guard. Measure first: the two-week census after the block (see `state/census/2026-10-22.tar.gz`, `dispatch-census.js`) shows whether writes moved to `sed -i`.
- **Fix:** in `bash-write-guard.js`, read the live model the same way the hook does and deny `sed -i` / `perl -pi` on source extensions from an Opus-or-above main thread unless that turn carries a dispatch, an open-call skip or a typed override, with the same message.

### Write-block's reply-text skip can never fire

- **Evidence:** `opus-write-nudge.sh:35` looks for `implementer: skip — open call:` in the current turn's assistant text, but a PreToolUse hook runs before that turn's text reaches the transcript (two live runs while building `step-gate.sh`: a same-turn skip line never lifted that gate, and mid-turn prose is often stored as `thinking` blocks the hook never sees). The documented escape is dead; the typed `[tier-override: <why>]` is the only one that works.
- **Why parked:** the harm is the message, not the block: it offers an escape that fails, and a design-call write today either dispatches or asks for the override. Needs one decision on where an open-call skip should live.
- **Fix:** carry the skip in the write itself, the way `step-gate.sh` reads it from the dispatch prompt's first line, or keep the typed override as the only escape; either way drop the reply-text clause from the hook, its message and `subagent-tiers.md`.

### Workers write source through interpreter scripts, unseen by write-time hooks

- **Evidence:** `implementer` hand-backs have said "I made the edits with a Python script, because the session was in auto mode and told me to use Bash for changes." `bash-write-guard.js` denies heredocs and inline interpreters, but a script file run from the scratchpad has no visible target, so comment-check, plan-lint and the Fable write-block never fired.
- **Why parked:** the agent definition now forbids it (`agents/implementer.md`), which fixes the common case; a mechanical guard needs a target-blind signal. `external-io` and `general-purpose` carry the same Bash-plus-Write shape.
- **Fix:** a PostToolUse Bash hook for workers that diffs the tree before and after an interpreter invocation (`python|node|bun … <file>`) and flags source files that changed, pointing at the Edit tool; or deny running a script that lives under the scratchpad against a repo cwd.

### Fable write-block catches scratchpad probe files

- **Evidence:** writing a throwaway `vitest.nosetup.config.ts` into the session scratchpad was denied as a source write; an `implementer` had to create a measurement probe.
- **Why parked:** the extension gate in `opus-write-nudge.sh` has no notion of where a file lives; exempting a path needs the scratchpad root, which only the session knows (`CLAUDE_SCRATCHPAD`-style env or the `/private/tmp/claude-<uid>/` prefix).
- **Fix:** in the `pre` arm, exit 0 when `file_path` starts with the session scratchpad prefix; a probe is not shipped code.

### Stop-gate block chains run long

- **Evidence:** "DONE-CLAIM WITHOUT EVIDENCE" averages 3.6 consecutive blocks per turn (longest 8, 12 sessions); "NAMED VERB NOT RUN" averages 2.7 (harden 28, battery 10, trim 7).
- **Why parked:** unknown whether the gate's condition is hard to satisfy or the model answers it wrongly; fixing blind risks loosening a real gate.
- **Fix:** read five of the longest chains, classify each block as gate-too-strict vs model-wrong, then adjust `hooks/done-claim-gate.sh` or its message accordingly.
- **Worth doing when:** a session loses three or more turns to one chain again.

### Review-lens verdict ceremony

- **Evidence:** 98 "REVIEW NOT RUN" Stop blocks in 32 sessions; 77 were answered with a text-only verdict line, not a review.
- **Why parked:** the accepted verdict forms were widened since, which may remove most of these; measure before changing more.
- **Fix:** if still high, prompt the verdict lines at the lens nudge instead of at Stop, or skip the gate for edits confined to `~/.claude`.
- **Worth doing when:** a fresh census still shows more than one block per code session.

### Write-guard sweep fallback still over-blocks

- **Evidence:** a write call whose destination is a plain variable or function parameter (not `process.argv`/`sys.argv`) falls back to sweeping every path-like token in the command, so mentioning source files blocks a scratch-only write. Seen once after the argv fix, and again on 2026-10-25: a `node -e` with `const p=process.argv[1]` wrote only a scratchpad file, but the same command's `git hash-object` / `update-index` named `subagent-tiers.md` and `plan-mode.md`, so a temp-index commit of selected hunks was denied.
- **Why parked:** loosening the fallback risks letting a real source write through; two sightings, one short of the trigger below.
- **Fix:** resolve simple same-script assignments (`const out = process.argv[2]`, `out = sys.argv[1]`) the way `PY_STRING_ASSIGN` resolves literals.
- **Worth doing when:** it blocks a legitimate command once more.

### Write-guard reads an interpreter call inside quoted text

- **Evidence:** a read-only `grep -n "…node -e\|writeFileSync…" hooks/bash-write-guard.js harness-backlog.md` was denied as a shell write to both files (2026-10-25). `interpreterTargets` runs `INTERPRETER` and `INTERPRETER_WRITE` on the unmasked command, so a quoted grep pattern reads as a `node -e` that writes, and the sweep fallback then blocks every path in the command.
- **Why parked:** one sighting, and reading the files with Read is a cheap way around it. Same false-positive class as the secrets-hook entry below.
- **Fix:** locate the invocation with `INTERPRETER` on `maskQuoted(executed)`, which keeps a real `node -e '…'` (the command word is unquoted) and drops one inside a quoted argument; keep `INTERPRETER_WRITE` and the write-call scan on the raw text. Add the grep as a quiet twin in `tests/bash-write-guard.test.js`.
- **Worth doing when:** it denies a legitimate command twice more.

### Secrets hook matches words inside quoted text

- **Evidence:** the `env-dump` rule (`hooks/protect-secrets.js:115`) matches `\bprintenv\b` anywhere in the raw command, so a commit whose message only mentioned the word was denied. Same false-positive class already fixed in `block-dangerous-git.sh`.
- **Why parked:** one sighting, and rewording the message is a cheap way around it; tokenizing every rule in the hook is a larger change than the friction.
- **Fix:** match command words only, not quoted arguments — reuse the `shlex` segment scan from `block-dangerous-git.sh`, or anchor the rule to command position (`(?:^|[;&|]\s*)printenv\b`).
- **Worth doing when:** it denies a legitimate command twice more.

### Implementer dispatched after an unread plan fold

- **Evidence:** a peer session's count, not re-run here: 3 sessions since the cold reader landed, all of which dispatched `implementer` after a plan edit no cold read followed (31 dispatches).
- **Why parked:** two days of history; most of those edits are wording folds `plan-mode.md` lets through without a re-read.
- **Fix:** if a re-count a month on still shows dispatches after behaviour folds: a `SubagentStop` hook stamps the cold reader's own `shasum` line (an agent-written stamp is denied by the auto-mode classifier), and `build-approval-gate.sh` re-arms only when the plan changed after the last cold read's report.

### Cold-read brief passes for async state and unverified failure paths

- **Evidence:** eval cases `planted-dplk-201-states` and `planted-dplk-201-statepass` (2026-10-23, opus high, three runs per arm; labels hand-checked into REAL / ENV / WRONG / DUP, kept in that session's scratchpad). Per read, means:
  - today's brief: planted hits 2.33 of 3 (F1, the unstated waiting states, caught 1 run in 3), distinct real extras 4.33, noise (ENV + WRONG) 10.67;
  - state-combination pass alone: hits 3.0, real 5.33, noise 12.0;
  - state pass plus "every Decided rule and failure path no verify exercises": hits 3.0, real 7.0, noise 14.67.
- **Why parked:** the pre-set rule was "hits rise and noise doesn't"; noise rose in both arms. The state pass's +1.33 noise sits inside run-to-run spread (baseline per-run noise 8, 9, 15), so it is unresolved rather than refuted.
- **Label rubric:** REAL = true of the plan, not planted; ENV = sandbox artefact; WRONG = a false plan or repo claim; DUP = restates another finding; noise = ENV + WRONG.
- **ENV share of baseline noise:** a quick re-count of runs 1-3 (2026-10-25) found 4 to 6 ENV per run (no git repo, no `node_modules`, no browser tool, a rule doc absent from the sandbox) and at most 2 WRONG. That sums below the hand-labelled 8, 9, 15, so the two counts disagree on the split; ENV is at least 4 per run either way.
- **Step 2 brief, eval skipped:** the eval was skipped for the `agents/cold-reader.md` confirmation rule: per-run noise spreads 8 to 15, wider than the change one brief line can make, and at least 4 per run is ENV the brief cannot move. Evidence is the two cold reads of `plan-gate-tiers`; reverting line 7 undoes it.
- **Fix:** first re-baseline the pending state-pass runs against the step 2 brief (`plan-gate-tiers`); the means above are the old brief's. Then three more runs per arm of the state pass alone; land it in `agents/cold-reader.md` line 7 if mean noise then stays at or under baseline. The judge's raw `false_positives` count mixes real out-of-plant findings with noise, so score with labels, not the raw count.
- **Related, no action:** plan-lint leads for mixed step forms, `## Steps:` headings and per-section P8 hit 0 of the 44 plans in `plans/`; re-check when a real plan does.

### SendMessage header and length check

- **Evidence:** `state/census/peer-census.md` (untracked): 745 messages; 17 over 3,000 characters, and 36% of builder→planner messages are progress.
- **Why parked:** the rules in `peer-sessions.md` land first.
- **Fix:** a PreToolUse SendMessage hook denying a message with no `[TYPE …]` header or over 1,200 characters.
- **Worth doing when:** a re-census shows over 10% of peer messages break either rule.

### SendMessage prompts despite the allow list

- **Evidence:** `state/census/peer-census.md` (untracked): 8 SendMessage permission prompts in 4 sessions, with `SendMessage` in the allow list at `settings.json:12`.
- **Why parked:** cause unknown.
- **Fix:** read the 8 prompts' tool inputs for a shared shape (socket-path address, cross-project target).
- **Worth doing when:** it prompts again.
