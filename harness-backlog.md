# Harness backlog

Measured harness friction, parked. One entry per item: the evidence, why it is not fixed yet, the fix, and what makes it worth doing. An entry leaves this file in the commit that fixes it. Counts come from a transcript census archived under `state/census/` (untracked; `tar -xzOf <archive> census/report.md`, re-run `census/extract.js` then `census/report.js`); re-run it before acting on a count older than a month.

## Open

### Review gate upgrades

- **Evidence:** `done-claim-gate.sh` now makes a done-claim, a REPORT or the shipping commit owe the session's unrun review members whatever the turn wrote, once the session wrote code or ran an agent. Three upgrades stay out; each bullet below carries its own evidence.
- **Why parked:** the build covered the routes the census found escaping review; each upgrade needs state or a hard stop the gate does not carry today.
- **Fix:** three upgrades, each with what it buys and what it costs:
    - Size Big by git range across sessions, with per-repo stamps of each member's last run. It catches the `352bbe1d` case: the planner's status answer (line 8177) replays to exit 0, and nothing was written in that session. It costs a state file per repo, heuristic repo discovery and git time inside the classifier's 6 s budget.
    - `code-reviewer` on Big REPORTs adds the battery's fifth member there. It costs a second size bar for one member.
    - A fail-closed classifier timeout on claim turns closes the 6 s fail-open that 3 of 21 large-session rows hit even warm. It costs a hard stop whenever git is slow, and a cold run already took 7.35 s on a replay.
- **Worth it when:** a status answer in a session that wrote nothing, or a Big REPORT, claims the work done and Praveen has to ask for the review.

### Plan gate reads a future "implement" as an ask to implement now

- **Evidence:** session `bb3f0c74` (2026-11-24): `done-claim-gate.sh` blocked six replies with PLAN PRESENTED UNREVIEWED. Two were false: they closed with "…and bring it back for \"implement\"", which names a later approval, and `later_approval` (`done-claim-gate.sh:205`) strips only `for your implement`. A third asked to implement a spike written to `/tmp/spike`, outside the session scratchpad that `build-approval-gate.sh` already exempts; that ask was self-inflicted. The other three asked to implement a plan edited since its last review, and were right.
- **Why parked:** one session; each false fire cost one reworded reply.
- **Fix:** `later_approval` also strips a quoted `"implement"` after `for` or `back for`. Firing / near-twin / empty-input tests, the near-twin being "type \"implement chunk 1\"" after an unreviewed edit.
- **Worth it when:** another session rewords a reply that asked nothing to pass the gate.

### Facts under a plain label line pass the plan lint

- **Evidence:** the OCBC `native-bridge` plan before its rewrite carried 44 lines of code reads under a label line, "Chunk facts, read on the tree after the first, File-based handoff build:". P10 in `hooks/plan-lint.js` keys on headings starting `Facts` or `Blocked on` and on `Rejected:` lines, so a label line passes; only `plan-mode.md`'s rule text covers it.
- **Why parked:** one sighting; a pattern keyed on one wording is speculative.
- **Fix:** P10 also fires on a line that starts `Facts` or `Chunk facts` and ends with a colon, with a quiet near-twin for a step bullet that mentions facts.
- **Worth it when:** a second plan shows facts under a label line after commit `73b9034`.

### Lint gate fires on harness scripts that have no linter

- **Evidence:** session `0a05d180`: `done-claim-gate.sh` blocked with LINT/TSC NOT RUN three times (twice on 2026-11-19, once on 2026-11-21) on turns that wrote a Node script under `~/.claude` or the session scratchpad and committed. `~/.claude` has no linter, type checker or `package.json` script, and the gate's static-check pattern accepts only lint or `tsc` commands, so `node --check`, `bash -n` and the harness suite (1015 of 1015) did not count.
- **Why parked:** the hook edits that blocked it are committed; it waits only on Praveen's ask.
- **Fix:** when every code file the turn edited sits under `~/.claude` or a scratchpad, the gate accepts `node --check`, `bash -n` or the `node --test` harness suite as the static check. Firing / near-twin / empty-input test triple; the near-twin is a repo file edited in the same turn, which still needs lint.
- **Worth it when:** now; planned on Praveen's ask.

### Cold-read cap rests on the rule alone

- **Evidence:** `plan-build.md` caps cold reads at two per chunk and asks for Praveen's typed ask before a third; no hook checks it. Not measured: no count of cold reads per chunk with typed asks separated exists. The one chunk watched (the dry-run re-count, session `0a05d180`) had exactly two, about 73k tokens each.
- **Why parked:** no evidence of a third read without an ask; the dry-run census (`state/census/dry-run-scope/`) reports review tokens per plan, dry runs plus cold reads, against a 513k baseline.
- **Fix:** an Agent-dispatch hook that denies a third `cold-reader` dispatch on one plan chunk unless the typed prompt asks for it, and denies a `cold-reader` prompt that is more than the plan path. Starts from the missing count.
- **Worth it when:** that census's comparison line shows review tokens per plan above 513k, or a transcript shows a third cold read no one asked for.

### Skills have no evals

- **Evidence:** 15 skills under `skills/`, none covered by a case; hooks have 726 node tests. `evals/cases/` holds only `code` and plan kinds, run by `automation/eval-run.sh` and scored by `eval-score.sh`.
- **Why parked:** no skill regression observed yet; each eval run spends model tokens.
- **Fix:** add a `skill` kind to the existing harness (`automation/eval-lib.sh` switches on `kind`), one case per judgment-carrying skill, starting with `tailwind-v4` and `tdd`: prompt, planted expectation, judge score. Run before and after a skill edit. Not `claude plugin eval`: a second eval convention beside this one.
- **Worth it when:** the first edit to `tailwind-v4` or `tdd`, or the first skill regression noticed in a transcript.

### Plan churn: decisions settle after steps are written

- **Evidence:** census of 169 plan-file edits in three sessions (`plans/peer-plan-review.research.md`). Reviews (cold read, dry run, advisor) start 47%, but the rework came from decisions: in `0bdc42f6` the N/A-key decision flipped three times (Decided list edited 13 times), and one 8,155-char rewrite was then reworked by 16 edits, ending in a step retitled "Reverted".
- **Why parked:** one session carries the flips; review-by-size (`7c68d52`, `77cffd4`) shipped the same day, and a second change now would confound its measurement.
- **Fix:** before writing Steps, the planner puts each Decided candidate to Praveen as one short decision round; Steps are drafted only once Decided is settled. The over-built rewrite is a separate cause with its own rule: `plan-mode.md` "Criteria → steps → checks" holds a Decided entry that adds behaviour to a criterion, and `plan-build.md` "Every reviewer's input" stops a reviewer fold adding scope no criterion needs.
- **Alternative, drafted:** `plans/peer-plan-review.md` routes planning-time dry runs and cold reads to the bound builder via a REVIEW message. It saves planner context and the duplicate HANDOFF design review, not plan edits.
- **Worth it when:** a re-run of the plan-churn scan over the next 2–3 plan builds still shows a Decided entry edited 5+ times or a step reverted.
- **Scan re-run, 2026-11-18:** 69 plan files edited since plan-lint P9 and review-by-size landed, replayed from transcripts (1,408 edits replayed, 377 could not be). No single Decided entry was edited more than 5 times (one at 5, in `weekly-automation.md`) and no step was retitled Reverted, so the trigger above is met only at its threshold. The Decided section as a whole still took 220 of the replayed edits, up to 36 in one plan: entries are added more than flipped. The Decided-to-criterion rule landed after this scan, so the next scan measures it: `python3 -I automation/plan-churn.py`, with its `SINCE` constant set to the day that rule landed. The script is run by hand and deleted with this entry.

### High-risk path flag keys on the file name, not the change

- **Evidence:** the query stale-time build (`0a05507a`): a 140-line chunk turned Big because `use-order-portfolio.ts` matched `review-classify.py`'s risk pattern on "order", for a 3-line `staleTime` removal; 19 review agents ran at chunk end.
- **Why parked:** one sample, and "order portfolio" may be a real money path, so the flag may have been right and only the hunk trivial. A policy change for every HIGH-risk path was tried and reverted for that reason.
- **Fix:** score risk on the hunks, not the path: a risky path whose diff only deletes or renames options does not raise the range to Big.
- **Worth it when:** a second build turns Big on a risky path whose hunks are trivial.

### Planner names the done bar before the diff exists

- **Evidence:** the same build: the planner's HANDOFF asked for "the full Big done bar" at step 1, and its GO repeated it, so the builder ran Big whatever the chunk diff earned (`peer-sessions.md` "the done bar its chunk diff earns").
- **Why parked:** one sample; that planner's context still held the pre-review-by-size rule text, so it may be stale context, not a rule gap.
- **Fix:** a HANDOFF or GO never names a tier; the builder classifies the chunk diff with `review-classify.py` at chunk end.
- **Worth it when:** a planner started after review-by-size shipped still names a tier up front.

### Draft-chunk lint is dodged by dropping the label

- **Evidence:** P9 in `plan-lint.js` reads only `## … (draft)` sections, so a later chunk written without the label is never checked.
- **Why parked:** lint cannot tell which chunk is next; no dodge seen yet.
- **Fix:** in a plan with 2+ `## Chunk` headings, flag line cites in every chunk after the first one that carries none of its own commits; needs a commit-aware check.
- **Worth it when:** a plan census shows unlabelled later chunks carrying line cites.

### Battery tier A/B before moving multi-hop members to Opus

- **Evidence:** `review-battery.md` runs the multi-hop members (code-reviewer, silent-failure-hunter, type-design-analyzer, reuse-analyzer, placement-analyzer) at the session tier and the single-pass members on Opus. The Opus-vs-session comparison has to be re-run on a frozen diff: a diff that moves mid-run invalidates it.
- **Why parked:** no valid comparison exists, and the session tier is the working default.
- **Fix:** re-run the A/B on a frozen diff, then move the multi-hop members to Opus only if the result supports it.
- **Worth it when:** moving the multi-hop members to Opus is next proposed.

### Same-file edit counter (thrash nudge)

- **Evidence:** 30-day census of main-thread Edit/Write on source files (2026-10-22, `edit-census-filtered.py` in that session's scratchpad): 88 of 1,428 (turn, file) pairs carry 5+ edits, across 52 of 166 editing sessions; 14 pairs carry 10+. The top rows are new hook scripts and spec files being built up, not visible thrash.
- **Why parked:** a nudge at 5 fires in a third of editing sessions, mostly on ordinary iteration; at 10 it would fire ~14 times a month on turns nobody has read yet. The `systematic-debugging` skill's trigger (two failed hypotheses) already names the real signal by rule.
- **Fix:** read five of the 10+ turns; if most are edit → failing test → edit loops, a PostToolUse Write|Edit hook counting per `(session, file)` since the last typed prompt, nudging once at 10 toward `systematic-debugging`. Idea from Claude Forge's `loop-detection.sh`.

### commit-trailer-check.sh reads the wrong commit in two shapes

- **Evidence:** the hook reads `git log -1` in the command's `git -C` dir or the session cwd. A `git commit` that exits 0 without committing re-reads the previous HEAD, so an older trailer there blocks an unrelated turn; `cd dir && git commit`, `git -c k=v -C dir commit` and a relative `-C` path are read against the session cwd, so a trailer in `dir` is missed.
- **Why parked:** neither shape has occurred; the first needs an older trailer already in HEAD, the second only misses (never blocks wrongly).
- **Fix:** record `git rev-parse HEAD` in a PreToolUse twin and skip when it is unchanged; resolve `cd <dir> &&` and any `-C` position, relative to the hook input's `cwd`.

### Existing hook tests lack quiet-twin and empty-input cases

- **Evidence:** `harness.md` requires both, applied to a hook when next touched.- **Why parked:** the rule applies on touch; a retro-audit of every hook has no failure behind it yet.
- **Fix:** per hook, feed `{}`, a missing transcript and an unmatched command, and assert the documented fail-open or fail-closed outcome.

### Workers write source through interpreter scripts, unseen by write-time hooks

- **Evidence:** `implementer` hand-backs have said "I made the edits with a Python script, because the session was in auto mode and told me to use Bash for changes." `bash-write-guard.js` denies heredocs and inline interpreters, but a script file run from the scratchpad has no visible target, so comment-check, plan-lint and the Fable write-block never fired.
- **Why parked:** the agent definition now forbids it (`agents/implementer.md`), which fixes the common case; a mechanical guard needs a target-blind signal. `external-io` and `general-purpose` carry the same Bash-plus-Write shape.
- **Fix:** a PostToolUse Bash hook for workers that diffs the tree before and after an interpreter invocation (`python|node|bun … <file>`) and flags source files that changed, pointing at the Edit tool; or deny running a script that lives under the scratchpad against a repo cwd.

### Stop-gate block chains run long

- **Evidence:** "DONE-CLAIM WITHOUT EVIDENCE" averages 3.6 consecutive blocks per turn (longest 8, 12 sessions); "NAMED VERB NOT RUN" averages 2.7 (harden 28, battery 10, trim 7).
- **Why parked:** unknown whether the gate's condition is hard to satisfy or the model answers it wrongly; fixing blind risks loosening a real gate.
- **Fix:** read five of the longest chains, classify each block as gate-too-strict vs model-wrong, then adjust `hooks/done-claim-gate.sh` or its message accordingly.
- **Worth doing when:** a session loses three or more turns to one chain again.

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
- **Fix:** if a re-count a month on still shows dispatches after behaviour folds: a `SubagentStop` hook stamps the cold reader's own `shasum` line (an agent-written stamp is denied by the auto-mode classifier), and `build-approval-gate.sh` re-arms only when the plan changed after the last cold read's report. Under the per-chunk cap (`plan-build.md` Review) a decision fold needs a dry run, not a cold read, so the re-count keys on either review after the plan's last edit.

### Cold-read brief passes for async state and unverified failure paths

- **Evidence:** eval cases `planted-dplk-201-states` and `planted-dplk-201-statepass` (2026-10-23, opus high, three runs per arm; labels hand-checked into REAL / ENV / WRONG / DUP, kept in that session's scratchpad). Per read, means:
  - today's brief: planted hits 2.33 of 3 (F1, the unstated waiting states, caught 1 run in 3), distinct real extras 4.33, noise (ENV + WRONG) 10.67;
  - state-combination pass alone: hits 3.0, real 5.33, noise 12.0;
  - state pass plus "every Decided rule and failure path no verify exercises": hits 3.0, real 7.0, noise 14.67.
- **Why parked:** the pre-set rule was "hits rise and noise doesn't"; noise rose in both arms. The state pass's +1.33 noise sits inside run-to-run spread (baseline per-run noise 8, 9, 15), so it is unresolved rather than refuted.
- **Label rubric:** REAL = true of the plan, not planted; ENV = sandbox artefact; WRONG = a false plan or repo claim; DUP = restates another finding; noise = ENV + WRONG.
- **ENV share of baseline noise:** a quick re-count of runs 1-3 (2026-10-25) found 4 to 6 ENV per run (no git repo, no `node_modules`, no browser tool, a rule doc absent from the sandbox) and at most 2 WRONG. That sums below the hand-labelled 8, 9, 15, so the two counts disagree on the split; ENV is at least 4 per run either way.
- **Step 2 brief, eval skipped:** the eval was skipped for the `agents/cold-reader.md` confirmation rule: per-run noise spreads 8 to 15, wider than the change one brief line can make, and at least 4 per run is ENV the brief cannot move. Evidence is the two cold reads of `plan-gate-tiers`; reverting line 7 undoes it.
- **Narrow-brief arm:** measured 2026-11-14 and not landed. A brief that reports a guess only when no named check settles it, starts each finding with its kind and says a short report is correct was run three times against three runs of the committed brief (opus high, hand labels, not blind). Planted hits 6 against 6, F2 and F3 in every run (pass); behaviour plus decision extras 5.3 per run down to 1.0 (fail, the bar was a loss of at most 1.0); build detail 1.7 down to 0.0 (pass); 8 of 9 extras opened with a kind word (pass), six of them sandbox artefacts marked `behaviour`. It cut extras from 13.0 to 3.0 per run and dropped vacuous-verify findings every base run reported. F1 was missed in all six runs and in three more at medium effort; medium also missed F2 once (5 hits of 9, 2.4 to 6.0 minutes), so cold reads stay at high effort. Runs, labels and the lost findings: `plans/plan-review-convergence.research.md` section 10.7.
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

### Weekly learn re-reads a resumed session whole

- **Evidence:** `learn-digest.sh` selects by file modification time (`find -newer <cursor>`) and digests the whole file, so a session digested one week and resumed the next is read again from its first record (or from the head-cut point, for a session over the file cap) and a lesson from its first part can be proposed twice. Unobserved: one weekly run on record, and `state/learn/cursor` was absent after it although `state/learn/2026-11-09.md` exists, so no run has yet started from a cursor.
- **Why parked:** the case has not been seen, and the digest's size cap has never been hit (155,129 of 409,600 bytes in the one run).
- **Fix:** digest only the records stamped after the cursor's time; `user` and `assistant` records carry an ISO `timestamp` in UTC whose first 19 characters compare as strings, so the cursor's local mtime is rendered in UTC first (`date -u -r <cursor> +%Y-%m-%dT%H:%M:%S`).
- **Worth it when:** a weekly report proposes a lesson that an earlier report already proposed from the same session.

### Git guard misses command shapes that sessions do not use

- **Evidence:** replayed through `hooks/block-dangerous-git.sh`, 19 commands that should be denied pass (commit `-a` after the message, `git add -- .`, a forced branch delete written `-d -f`, `mv` or `unlink` of a lockfile, a push from the backup repo to another remote or behind `stdbuf`), 5 harmless ones are denied (a message or search pattern that mentions a guarded command), and the guard is not started behind `env`, `command`, `nohup`, `bash -c` or `eval`. A census of 57,796 Bash calls in 3,380 transcripts holds none of those shapes but one, `git -C <dir> add -A` (11 calls), which the guard now denies. A review on 2026-11-20 added shapes that pass from the shared checkout: a guarded call after a leading `{`, `!`, `then` or `do`, or behind `timeout`; one with `-C` in a command `shlex` cannot split (an apostrophe in a trailing comment); and an owner's reset after an earlier call set `GIT_DIR` in a startup file, added a config filter or swapped a symlink.
- **Why parked:** the hook blocks the shapes sessions use. The rewrite (token scan, one plain form for the backup push, 17 more `if` entries) went through two cold reads and still had open gaps.
- **Fix:** extend the one pattern the new shape belongs to, as was done for bulk staging behind `-C`. The full rewrite only when several shapes turn up.
- **Worth it when:** a transcript shows a missed shape staging, pushing or deleting something it should not have.

### Hydrogen reference cites three widgets the monorepo does not hold, and the map predates the audit date

- **Evidence:** `plans/usage-fixes.research.md` row H5: `ls -d ~/Documents/projects/hydrogen/hydrogen/widgets/*/*` holds no `maturing-bonds`, `compliance-breach` or `funds-list`, which `hydrogen-reference.md` cites under `widgets/wealth`. `hydrogen.md:5` dates the last full audit 2026-07-09, while hera's last commit to `hydrogen-component-map.json` is 2026-03-17, though the audit tripwire requires regenerating the map.
- **Why parked:** a consuming app may hold the three widgets, which the monorepo alone cannot settle.
- **Fix:** locate each widget in the apps or delete its citation, then re-date the audit.
- **Worth it when:** a session follows one of the three citations to nothing.

### react-best-practices keeps rules that contradict code-craft.md

- **Evidence:** `plans/harness-sweep.research.md` section 5: bare `catch {}` in `rules/client-localstorage-schema.md`, a module-level login cache in `rules/js-cache-function-results.md:60-76`, and `rules/bundle-barrel-imports.md` rated critical on Next/webpack numbers.
- **Why parked:** no session hit them.
- **Fix:** rewrite the bare `catch` examples, drop the module-level login cache, and re-rate barrel imports for Vite.
- **Worth it when:** a review cites one of them.

### Gates match words in prose where they mean commands

- **Evidence:** `plans/harness-sweep.research.md` sections 1-2 and its usage census: done-claim evidence, commit and in-place-write detection match quoted text; a denied, interrupted or backgrounded run counts as evidence; plan-review coverage matches a plan's basename inside another name; negated Fable and Sonnet mentions count as asks. The census counted the gate's blocks (review-not-run about 250, done-claim about 90) but not these false-fire shapes.
- **Why parked:** no count shows a session hit one; the two shapes that were counted shipped in `3a0191a`.
- **Fix:** match at command position with quoted spans blanked; treat a denied or backgrounded run as no evidence; match the plan name on a path boundary.
- **Worth it when:** a transcript shows one of these shapes passing or blocking a turn wrongly.

### Dependency, secrets and shell-write guards miss wrapped forms

- **Evidence:** usage census, 2026-11-10: installs behind `env`, `command`, `nohup` or a shell `-c` 0 calls; `npx expo install` 0; a quoted package spec 1 (a scratch probe); `diff`/`sed` on a secret file about 1; `perl -pi` 49 against 563 allowed `sed -i`; `tee` to a source file 2; `node --eval` 0.
- **Why parked:** sessions do not use the shapes; `npm pkg set`, the one that was used, shipped in `3a0191a`.
- **Fix:** start the dependency gate behind wrapper words; apply the secrets allowlist per path token; deny `perl -pi` and `tee` writes to source as `sed -i` is not.
- **Worth it when:** a session installs behind a wrapper, or `perl -pi` edits source that a write-time hook should have seen.

### Six hooks each carry their own list of source extensions

- **Evidence:** usage census: Write/Edit by extension `.tsx` 5,345, `.ts` 4,461, against `.cts` 28, `.html` 14, `.py` 10, `.mts` 4, `.kts` 0, the ones some lists omit.
- **Why parked:** 56 writes in about 9,800 fall outside a list.
- **Fix:** one shared list under `hooks/lib/` read by all six hooks.
- **Worth it when:** a repo with `.mts`, `.cts` or `.kts` source becomes regular work.

### Rule docs disagree with each other in small ways

- **Evidence:** `plans/harness-sweep.research.md` section 3: `commands/cycle.md` and `plugin-curation.md` against `committing.md` on unasked commits; `output-styles/peer-engineer.md` has no word ceiling; the Tailwind focus-ring rule sits outside the `tailwind-v4` skill.
- **Why parked:** doc drift with no counted fault.
- **Fix:** one pass over the docs named, each edit checked against the hook it describes.
- **Worth it when:** a session follows one of the stale lines, or the next doc edit touches one of these files.

### Three more skills describe options and files they do not have

- **Evidence:** `plans/harness-sweep.research.md` section 5; skill calls in the usage census: `a11y-audit` 0, `improve-codebase-architecture` 0, `systematic-debugging` 1, `verification-before-completion` 2, `tdd` 0.
- **Why parked:** the skills are almost never invoked.
- **Fix:** `a11y-audit` usage rewritten from its scripts' real options and its dead references deleted; `systematic-debugging` trigger and `find-polluter.sh` failure fixed; `improve-codebase-architecture` names its agent; thresholds in `verification-before-completion` match `tdd`.
- **Worth it when:** one of them is invoked for real work and misleads.

### Some hook tests cannot fail

- **Evidence:** `plans/harness-sweep.research.md` section 7: surviving mutants in the browser guard, plan-mode injector, learn-due and glob-quoting tests; tests that read the live `~/.claude`; three hooks with no behaviour test (`harness-context.sh`, `hydrogen-util-guard.sh`, `plugin-drift-guard.sh`); branches listed there as untested.
- **Why parked:** test debt, no fault in use; overlaps `Existing hook tests lack quiet-twin and empty-input cases` above.
- **Fix:** one case per surviving mutant, a behaviour test per untested hook, checkout copies in place of live reads.
- **Worth it when:** one of those hooks is next edited.

### Unpinned browser server, duplicate allow entries, untracked scripts

- **Evidence:** `plans/harness-sweep.research.md` section 4: the browser MCP server in `~/.claude.json` has no exact version; `settings.json` holds duplicate allow entries; `scripts/` is untracked.
- **Why parked:** `~/.claude.json` sits outside the repo and `settings.json` carries uncommitted changes of the owner's.
- **Fix:** pin the server, remove the duplicates, track `scripts/`.
- **Worth it when:** `settings.json` is next cleaned up, or a browser server update breaks a session.

### Smaller sweep leftovers

- **Evidence:** `plans/harness-sweep.research.md`: `CLAUDE.md` has its baseline in `tests/budget-baseline.json` raised with each added rule; the review join for "an ask naming shared state, public API or a money-moving mutation" has no code behind it; `evals/results.md` is overwritten each run, so evidence a rule doc cites does not survive.
- **Why parked:** which rule leaves `CLAUDE.md` is the owner's choice; the other two have no counted fault.
- **Fix:** move one `CLAUDE.md` rule into the doc it points to; implement or delete the review join; date-stamp eval results.
- **Worth it when:** `CLAUDE.md` reaches about 1,600 words.