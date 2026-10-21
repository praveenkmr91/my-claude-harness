# my-claude-harness

The hand-authored half of my `~/.claude` directory: the rules, hooks, agents, skills and tests that shape how Claude Code works for me. Runtime state (transcripts, plugin caches, memory, plans, local settings) is deny-listed in `.gitignore`; only what is listed there explicitly is tracked. The repo is a private backup of a working setup, not a template — hook paths and the launchd plist are absolute to this machine.

## Layout

| Path | What it holds |
|---|---|
| `CLAUDE.md` | Global instructions: who I am, how to gate decisions, when to plan, how to delegate. Short; it points at the rule docs below. |
| `persona-core.md`, `output-styles/peer-engineer.md` | The voice: a principal engineer collaborating as a peer. The decay-prone subset is re-injected on every prompt. |
| `code-craft.md` | How written code should read: placement, layering, lifecycle, fixtures, comments. Injected on the first source-file touch. |
| `committing.md` | When to commit, what goes in one commit, squash and undo mechanics, worktrees, no attribution trailers. Injected on the first git command. |
| `plan-mode.md` | Plans are files: criteria → steps → `→ verify:` checks, dry-run, pre-mortem, cold read, consult, chunking, approval semantics. |
| `review-routing.md`, `review-battery.md` | Which review depth a verb buys (review / battery / harden / trim / audit / verify) and the agent battery behind the heavy tier. |
| `subagent-tiers.md` | Which model tier each kind of work runs on, enforced by a hook. |
| `external-io.md`, `library-docs.md`, `browser-verify.md` | Rules for MCP tools, library documentation lookup, and browser verification. |
| `hydrogen.md`, `hydrogen-reference.md` | Repo-gated guidance for one internal design system; loads only inside repos that depend on it. |
| `harness.md`, `harness-backlog.md` | How this harness itself is maintained, and parked friction with evidence. |
| `plugin-curation.md` | Which plugins are on, which are deliberate tombstones, and why. |
| `agents/` | Custom subagents: `implementer`, `checker`, `external-io`, `browser-verifier`, `dfs-lookup`, the plan readers `cold-reader` and `dry-runner`, and the review lenses `reuse-analyzer`, `placement-analyzer`, `modern-ts-analyzer`, `adversarial-reviewer`. |
| `commands/` | Slash commands: `/cycle`, `/learn`, `/delete-list`, `/delete-audit`, `/shortcut-debt`. |
| `skills/` | Localised skills (TDD, systematic debugging, verification before completion, Jira, a11y and web-quality audits, and others). `skills/synced/` is vendored by a sync job and untracked. |
| `hooks/` | The enforcement layer — see below. |
| `automation/` | Weekly repo audit (launchd), a context canary that checks every injection channel still reaches the model, and an eval runner for comparing model tiers on review tasks. |
| `tests/` | `node --test` suite over the whole harness. |

## Hooks

Rules that must hold are enforced, not just written down. Each hook is a small shell or Node script wired in `settings.json`:

- **Context injection** — `inject-once.sh` loads a rule doc the first time its trigger fires in a session (git → `committing.md`, source edit → `code-craft.md`, Agent → `subagent-tiers.md`, …); `inject-plan-mode.sh`, `harness-context.sh`, `hydrogen-context.sh`, `docs-context.sh` do the same for their domains.
- **Git guards** — `block-dangerous-git.sh` denies `git push`, asks on `gh pr create`, strips attribution trailers; `commit-trailer-check.sh` re-checks the landed commit.
- **Write guards** — `bash-write-guard.js` blocks shell-side writes (heredocs, redirects, `tee`) to source and docs so the Write/Edit hooks always see them; `protect-secrets.js` keeps `.env` and credentials out of text tools; `new-dep-gate.js` asks before a new dependency; `plan-lint.js` refuses research narrative inside a plan file; `comment-delta-check.js` watches comment bloat.
- **Done gates** — `review-classify.sh` reads the prompt and diff into a review verb plus lens list; `review-lens-nudge.sh` surfaces those lenses mid-turn; `review-routing-once.sh` injects `review-routing.md` on a review ask; `done-claim-gate.sh` blocks a "done" claim or commit ask until lint, type-check and every named lens have run.
- **Model tiers** — `enforce-subagent-model.sh` pins each agent kind to its tier and denies escalation; `opus-write-nudge.sh` pushes approved-plan edits off the main thread to the `implementer` and blocks source writes from a Fable session outright; `browser-main-guard.sh` denies a main-thread browser action, which runs on the `browser-verifier` agent or a fork; `agent-file-scope.sh` reports a subagent that wrote outside the files its brief named.
- **Housekeeping** — `reset-context-flags.sh` clears the once-per-session injection flags; `plugin-drift-guard.sh` warns when enabled plugins drift from the blessed snapshot; `audit-due.sh` nudges when a repo has had no audit in 30 days; `correction-learn.sh` detects a correction in a prompt and asks for a `/learn` pass. `protect-secrets.js` is a frozen, locally tuned copy of karanb192/claude-code-hooks (MIT).

## Tests

```sh
node --test ~/.claude/tests/*.test.js
```

Checks that every pointer in a rule doc resolves, that each hook agrees with the rule it enforces (`rule and hook agree` pairs), that always-loaded docs stay under their word ceilings (`tests/budget-baseline.json`), that no sentence is duplicated across rule docs, and that every top-level `.md` is tracked. The model for a hook test is a firing case, a near-twin that must stay quiet, and an empty-input case (`tests/bash-write-guard.test.js`); older hooks are brought to that shape when next touched. Run after any edit to a rule doc, hook or `settings.json`.

## Principles

- **One tier owns a rule.** A principle lives in exactly one file; everything else points at it.
- **Enforce, don't remind.** If a rule matters, a hook checks it; prose alone decays over a long session.
- **Current instructions, never a journal.** Rule docs and plans are rewritten in place with no dates or incident log; the *why* behind a rule is one clause, and the history is `git log`.
- **Measure before changing the harness.** Friction goes into `harness-backlog.md` with evidence; usage questions are answered from transcripts, not memory.
