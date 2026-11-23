# Review battery — recipe (read on the `battery` verb, a Big done bar or a `required=` list)

| Member | Tier |
|---|---|
| pr-review-toolkit:code-reviewer, silent-failure-hunter, type-design-analyzer, reuse-analyzer, placement-analyzer | session (model omitted) — multi-hop lenses; the tier hook injects opus if the session is below it, so the battery cannot silently drop tier |
| comment-analyzer, modern-ts-analyzer | `model: "opus"` — single-pass lenses; still review work, so Opus and never the Sonnet mechanical tier |
| pr-test-analyzer | `model: "opus"`; only when package.json scripts has a test runner — a "missing tests" nag on a repo with no suite is noise, and the same finding from any other member (adversarial-reviewer's New Hire included) is dropped the same way, never offered |

- Members run on Opus even from a Fable session; the tier hook places them there unless Praveen's last typed turn contains `fable battery` / `battery fable` or says yes to a reply that ends a sentence with `Fable battery?`, the reserved phrase the hook keys on. Propose it only when the diff earns it, cost named.
- A model typed with the verb (`fable battery`, `battery sonnet`) goes to every member as `model:`, overriding the table. Sonnet is his cheap pass, never proposed: the launch line says so, since it missed real bugs Opus found in a tier eval. Haiku stays denied.
- HIGH risk flagged by the routing hook → add the adversarial-reviewer agent, plus security-review on the main thread. Bulk flagged → add /delete-list + /shortcut-debt. Neither flag → the members above, nothing more.
- The launch line names the diff under review (e.g. "plan commit `00b1bfa5`, local, no PR"): the `pr-review-toolkit:` prefix is only the plugin the agents ship in, and it reads as a PR flow when no PR exists.
- Beyond the required members, add the ones the diff calls for and name each member's effort on the launch line.
- All output is leads; confirm each at source before relaying.
- Open: re-run the Opus-vs-session A/B on a frozen diff before moving the multi-hop members to Opus; a diff that moves mid-run invalidates the comparison.

## Required members

- **Unreviewed line.** A source line from a Write, Edit or MultiEdit call, main thread or subagent, written since the last `code-reviewer` dispatch that did not error. The Big bullet counts a member's lines since that member's own last such dispatch, test files excluded.
- **Floor.** Under 20 unreviewed lines `required=` lists neither `code-reviewer` nor a signalled member; the Big bullet never lists a member with under 20 lines unreviewed by it.
- **Members.** Beyond `code-reviewer`, `required=` lists silent-failure-hunter, type-design-analyzer, comment-analyzer or modern-ts-analyzer, each only when the unreviewed text itself holds its signal, so a signalled member stays listed until `code-reviewer` runs; the Big bullet lists the first two without one.
- **Big.** `required=` also lists each of these that has 200 or more such lines, or a high-risk path among them: silent-failure-hunter, type-design-analyzer, reuse-analyzer and placement-analyzer; three new files alone list none, unlike the Big tier of `~/.claude/review-routing.md`.
- **Range.** Every owed member is given everything written since its last run, never the last commit alone; no hook checks that range. A rerun owed after a round that only applied the members' own confirmed findings goes at `effort: low` with a brief that asks for confirmed defects only and lists every decision already made as not to be raised; a rerun at the first round's depth re-finds decided items and grows another fix round.
- **Cleared by** an agent dispatch of the member in the claiming turn with no errored result; a typed findings, skip or not-run line never clears one.
- **Not owed** on a first line opening `Step N`, on a builder's `[REPORT`, or in a window a delivered REPORT opened.
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
