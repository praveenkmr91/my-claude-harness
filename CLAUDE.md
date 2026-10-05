# Global Claude Code Preferences

## About Praveen
- **Role.** Principal engineer / architect at additiv, frontend R&D.
- **Stack.** Web frontend (JS/TS — React, Next, Vue, Angular) + mobile (Swift, Kotlin, Flutter). NOT backend/systems (Go, Rust, Java, Python, .NET, SQL). Agent/plugin/tooling recommendations scoped to frontend+mobile.
- **Voice.** Owned by the `peer-engineer` output style + persona hook. Tight but complete: full sentences, one line per point — "too verbose" and "too clipped" are both misses. Depth only when explicitly asked.

## Before writing code
- **No new conventions when one exists.** Codebase already answers → never invent.
- **Gate = irreversible or architectural only.** New dep, new layer/boundary, 2+ defensible approaches, destructive op → state approach 2-3 lines, get yes/no. Everything else: proceed, state what you did. Full brainstorm only for truly ambiguous/greenfield.
- **Planning = plan file, any mode.** 3+ files of substantive change (a few-line ripple doesn't count) or gate above → draft in `~/.claude/plans/` first; the write loads plan-mode rules.
- **Dispatch proactively — decide, don't ask.** Explore/research/verify agent would tighten plan → fire it (one-sentence announce, no permission ask). Standing authorization for cheap workers. Plan note "verify X" / "confirm Y" IS trigger — dispatch *before* writing dependent section, not checkbox handed back to user.
- **Dependency ladder — new dep is last rung.** Before reaching for code: existing codebase helper → stdlib/language built-in → native platform (Intl, `<dialog>`, URL, fetch, CSS) → already-installed dep → only then propose new dep (name cost: bundle, maintenance, supply chain — get yes/no; installs and new `package.json` keys are hook-asked).
- **Ground against sampled reality, never memory.** Code touching an external interface (API, schema, config surface) only after a real sampled response exists; field names, nesting and types come from the sample. Endpoint missing/erroring/permission-denied → report the blocker with exact request+response, never fabricate past it. A 5xx body is evidence about one call, not an execution model — ask the contract owner. A "field is missing" claim needs a recursive key dump of more than one live instance.
- **Sample to falsify, not confirm.** List what would break the rule (rotated, flipped, empty, nested, multi-valued), pull one sample per axis; "exact on N samples" that share an untested property is no evidence.

## Code craft — write like a human, not vibe-coded
- **Rules live in `~/.claude/code-craft.md`** (placement, layering, lifecycle, fixtures and style), injected on the first Read, Write or Edit of a source file in each thread.

## Before claiming done
- **After every code change:** run linter + type checker before declaring done. Static-clean (lint+tsc) ≠ "done" — exercise change at runtime before claiming works. The ticket's worked example IS the acceptance test: replay it end-to-end at runtime before claiming fixed; if it can't pass under the chosen design, that's a design finding to raise before shipping.
- **Self-review diff through Code-craft lens before commit — required gate, not polish.** Lint + tsc + code-review passing ≠ reading like human. Delete-list first: what can go before what should change. Watch: comment bloat, same *why* stated twice. Inline for small diffs.
- **Right-size inherited/sibling boilerplate — one holistic sweep.** Per mirrored piece: load-bearing THIS case, or inherited? Drop what isn't. Review/simplify = ONE ranked simplify+correctness sweep, never reactive piecemeal.
- **Automated sweeps prove behavior preserved, or revert.** Comment/whitespace-only cleanup → `npx esbuild <file> --minify-whitespace` pre/post must byte-match (strips comments+whitespace; any diff = sweep touched code). Anything deeper (renames, restructures) → full verify gate; any red = revert the whole sweep, not patch forward.
- **No FE workarounds for BE contract gaps.** Poll/retry shims and client-side patches for a wrong or missing backend contract are not built — comment the exact ask on the ticket and block.
- **Stakeholder-facing text is concise, not terse.** Jira comments, PR descriptions, commit bodies: root cause in 2-3 sentences, the ask in 1-2 — no verification narratives, probe timings, trade-off essays. Full sentences readable without session context; cut padding, never connective tissue.

## Committing
- **Rules live in `~/.claude/committing.md`**, injected on the first git command in each thread.

## Delegating
- **Subagent:** open-ended research (3+ queries), specialized fits (Explore, implementer, checker, external-io, code-reviewer, frontend-design), 2+ independent parallel investigations. An omitted `model` inherits the session tier — dispatch a declared cheap agent rather than a bare `general-purpose`, or mechanical work burns Opus silently.
- **Direct tool:** known target (file path → Read, symbol → Grep), ≤3 parallel calls.
- **Anti-pattern:** subagent to read one known file.
- **Model tier by work KIND.** Brain work and code carrying a design call → Opus+; approved-plan steps and bulk sweeps → Sonnet `implementer`; no-judgment → Haiku `checker` (lint + tsc stay direct); unbounded external → `external-io`, one bounded read inline; Fable reviews plans only; the harness advisor only when stuck or before an irreversible / architectural commitment — never routine multi-step or done-checks. Spec `~/.claude/subagent-tiers.md`, injected on the first Agent call; `hooks/enforce-subagent-model.sh` enforces.
- **Never stop in-flight work on inferred intent.** A running agent or task stops only on an explicit "stop" / "kill" / "cancel". A request about what comes next (fresh session, new plan, handoff) never authorises it — list what's running and ask "stop or let it finish?". TaskStop discards the agent's work.

## Config & harness
- **Editing `~/.claude` (rule docs, hooks, settings)? `~/.claude/harness.md` owns the maintenance rules** — `hooks/harness-context.sh` injects it on first contact with `~/.claude` each session.
- **Review depth: `~/.claude/review-routing.md` owns it** (hook-injected on review asks) — battery only when named, never proactively.
- **Classifier or hook denial = stop and ask, never route around.** On a classifier block or hook-refused tool call: finish independent work, hand me the exact blocked action in one message, stop — I retry via `/permissions` → Recently denied, exiting auto mode, or `!`. No smaller pieces, no alternate tool — unless the denial names the sanctioned route.
- **`<private>…</private>` = use now, never persist.** Content inside the tags never lands in memory files, .remember/, CLAUDE.md, commits, or any artifact — reference it this session only.
- **Ask before writing, moving or deleting outside the repo, or a file I placed.** Raise the concern first, then wait. A repo secret stays put, gitignored.

## Tooling gotchas
- **zsh: quote grep globs** — `hooks/block-dangerous-git.sh` denies unquoted `--include=*`; an empty grep is unverified until the command exited 0.
- **Lockfiles: never full-regen to clean.** Drop removed dep: surgically delete stanza (`file:` local entries have no integrity hash) or `npm install --package-lock-only` — never `rm lock && install`, re-pins every `^`/`~` to today's registry (silent toolchain drift). Lockfile diff far bigger than change = diff resolved-version set before trusting.
- **Library APIs key on the installed version.** Every API claim cites `pkg@x.y.z` + source — none = lookup skipped. Ladder: `~/.claude/library-docs.md`.
- **Browser verification** — `~/.claude/browser-verify.md`, injected on the first chrome-devtools call.
