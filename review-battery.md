# Review battery — recipe (read on the `battery` verb, a Big done bar or a `required=` list)

| Member | Tier |
|---|---|
| code-reviewer, silent-failure-hunter, type-design-analyzer, reuse-analyzer, placement-analyzer | session (model omitted) — multi-hop lenses; the tier hook injects opus if the session is below it, so the battery cannot silently drop tier |
| comment-analyzer, modern-ts-analyzer | `model: "opus"` — single-pass lenses; still review work, so Opus and never the Sonnet mechanical tier |
| pr-test-analyzer | `model: "opus"`; only when package.json scripts has a test runner — a "missing tests" nag on a repo with no suite is noise, and the same finding from any other member (adversarial-reviewer's New Hire included) is dropped the same way, never offered |

- Members run on Opus even from a Fable session; the tier hook places them there unless Praveen's last typed turn contains `fable battery` / `battery fable` or says yes to a reply that ends a sentence with `Fable battery?`, the reserved phrase the hook keys on. Propose it only when the diff earns it, cost named.
- A model typed with the verb (`fable battery`, `battery sonnet`) goes to every member as `model:`, overriding the table. Sonnet is his cheap pass, never proposed: the launch line says so, since it missed real bugs Opus found in a tier eval. Haiku stays denied.
- HIGH risk flagged by the routing hook → add the adversarial-reviewer agent, plus security-review on the main thread. Bulk flagged → add /delete-list + /shortcut-debt. Neither flag → the members above, nothing more. Big work (Required members below) owes the Big members listed there with or without a flag; /delete-list and /shortcut-debt run on `trim` or `battery`, never owed.
- The launch line names the diff under review (e.g. "plan commit `00b1bfa5`, local, no PR").
- Beyond the required members, add the ones the diff calls for and name each member's effort on the launch line.
- All output is leads; confirm each at source before relaying.

## Required members

- **Uncleared write.** A source line from a Write, Edit or MultiEdit call, main thread or subagent, to a code file outside the test paths. It is cleared for a member by a finished main-thread run of that member started after the write, with no errored result, whose transcript shows the file; a background run is finished once its completion notification is in the transcript. `hooks/review-classify.py` alone decides this, over every run up to its call; the block names each owed member's unshown files.
- **Floor.** Under 20 uncleared lines a member is never owed, whatever the signal.
- **code-reviewer** is owed at 20 or more uncleared lines. **silent-failure-hunter** and **type-design-analyzer** are also owed at 20 or more when that member's own uncleared web text holds its signal. comment-analyzer, modern-ts-analyzer, reuse-analyzer and delete-list stay in `lenses=` and run on `trim` or `battery`, never owed.
- **Big.** With 20 or more uncleared lines that reach 200, or include a high-risk path, `required=` adds silent-failure-hunter and type-design-analyzer unsignalled, plus placement-analyzer and adversarial-reviewer; security-review joins when a high-risk path is among them. Three new files alone list none, unlike the Big tier of `~/.claude/review-routing.md`.
- **Range.** Every owed member is given everything written since its last run, never the last commit alone; a file named only in its brief stays unshown, so the block names it and a rerun reads it. A rerun owed after a round that only applied the members' own confirmed findings goes at `effort: low` with a brief that asks for confirmed defects only and lists every decision already made as not to be raised; a rerun at the first round's depth re-finds decided items and grows another fix round.
- **Cleared by** a run as above: an agent dispatch of the member, or for `security-review` a main-thread `Skill` call; a typed findings, skip or not-run line, a typed `/security-review`, and an agent dispatch named for the skill never clear one.
- **Owed at** a done-claim whose first line is not `Step N`, a REPORT, or the shipping commit that deletes the plan file; a commit or commit ask alone owes nothing. A `Step N` claim stays exempt unless the turn ships. A REPORT answering a STOP, and a no-code Stop in the window it opened, are exempt. A REPORT, and a Stop in a window a delivered REPORT opened, owe only the Big members, never `code-reviewer` or a member owed by its signal alone. The gate blocks while `required=` is non-empty, however many blocks came before; a reply that claims nothing passes.
- **Effort** is set per member on each dispatch (levels: the Effort bullet of `~/.claude/review-routing.md`); a dispatch with none is denied.

## What calls for each member

- **code-reviewer:** new logic or changed control flow.
- **silent-failure-hunter:** catch blocks, fallbacks, default values.
- **type-design-analyzer:** new or reshaped types.
- **reuse-analyzer:** a new function, hook, helper or component.
- **placement-analyzer:** a new file, moved code, a call across layers.
- **comment-analyzer:** added comments.
- **modern-ts-analyzer:** legacy idioms in added TS or JS.
- **pr-test-analyzer:** source without specs, in a repo with a test runner.
