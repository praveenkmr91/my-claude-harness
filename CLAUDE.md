# Global Claude Code Preferences

## About Praveen
- **Role.** Principal engineer / architect at additiv, frontend R&D.
- **Stack.** Web frontend (JS/TS — React, Next, Vue, Angular) + mobile (Swift, Kotlin, Flutter). NOT backend/systems (Go, Rust, Java, Python, .NET, SQL). Agent/plugin/tooling recommendations scoped to frontend+mobile.
- **Voice.** Owned by the `peer-engineer` output style + persona hook. Tight but complete: full sentences — "too verbose" and "too clipped" are both misses.

## Before writing code
- **No new conventions when one exists.** Codebase already answers → never invent. Tooling too: repo scripts, `tooling/`, skills and docs before any ad-hoc probe, script or raw MCP call.
- **Gate = irreversible or architectural only.** New dep, new layer/boundary, 2+ defensible approaches, destructive op → state approach 2-3 lines, get yes/no. Everything else: proceed, state what you did. Full brainstorm only for truly ambiguous/greenfield. A scope I set stands until I change it: "wrap up"/"finish" stay inside it.
- **Planning = plan file, any mode.** 3+ files of substantive change (a few-line ripple doesn't count) or gate above → draft in `~/.claude/plans/` first; the write loads plan-mode rules.
- **Dispatch proactively — decide, don't ask.** Explore/research/verify agent would tighten plan → fire it (one-sentence announce, no permission ask). Standing authorization for cheap workers. Plan note "verify X" / "confirm Y" IS trigger — dispatch *before* writing dependent section, not checkbox handed back to user.
- **Dependency ladder — new dep is last rung.** Before reaching for code: existing codebase helper → stdlib/language built-in → native platform (Intl, `<dialog>`, URL, fetch, CSS) → already-installed dep → only then propose new dep (name cost: bundle, maintenance, supply chain — get yes/no; installs and new `package.json` keys are hook-asked). Measure ownership, not lines: library or ported code replacing hand-written behaviour wins. A devDependency skips the cost pitch, not the hook: pin it exactly and say so.
- **Ground against sampled reality, never memory.** Code touching an external interface (API, schema, config) waits for a sampled response; field names, nesting, types and validation come from it. One sample covers one path; a sibling path needs its own. Endpoint missing or erroring → report exact request+response, never fabricate past. A 5xx body describes one call, not an execution model — ask the owner. "Field missing" needs a recursive key dump of 2+ live instances; "API missing" needs a synonym search of every contract spec's paths, summaries and descriptions.
- **Sample to falsify, not confirm.** List what would break the rule (rotated, flipped, empty, nested, multi-valued) and pull one sample per axis; N samples sharing an untested property prove nothing. Design calls on existing wiring: answer every deciding question first (why it's wired so — git log + originating ticket; sibling pattern; each candidate source's scope), then recommend once, never from a partial sample.
- **A reviewer's finding is a claim, not a fix — check it at source before folding or relaying.** Peer session, subagent, advisor or cold read alike: read the cited `file:line` or re-run the probe first; an unchecked finding goes to me labelled unverified, never folded. A fold that changes behaviour or settles an Open item comes to me as a proposal.

## Code craft — write like a human, not vibe-coded
- **Rules live in `~/.claude/code-craft.md`** (placement, layering, lifecycle, fixtures and style), injected on the first Read, Write or Edit of a source file in each thread.

## Before claiming done
- **After every code change:** run linter + type checker before declaring done. The ticket's worked example IS the acceptance test: replay it end-to-end at runtime before claiming fixed; if it can't pass under the chosen design, that's a design finding to raise before shipping.
- **No FE workarounds for BE contract gaps.** Poll/retry shims and client-side patches for a wrong or missing backend contract are not built — comment the exact ask on the ticket and block.
- **Stakeholder-facing text (Jira, PR, commit) is concise, not terse.** Root cause 2-3 sentences, ask 1-2, done note 1-2 (Jira: no commit hashes). No verification narratives, tested-case lists, env caveats, trade-off essays. Full sentences, readable without session context; cut padding, not connective tissue.

## Committing
- **Rules live in `~/.claude/committing.md`**, injected on the first git command in each thread.

## Delegating
- **Subagent:** open-ended research (3+ queries), specialized fits (Explore, implementer, checker, external-io, browser-verifier, code-reviewer, frontend-design), 2+ independent parallel investigations. An omitted `model` inherits the session tier — dispatch a declared cheap agent rather than a bare `general-purpose`.
- **Direct tool:** known target (file path → Read, symbol → Grep), ≤3 calls per question, all rounds counted; a 4th → Explore.
- **Model tier by work KIND.** Brain work and design-carrying code → Opus+; approved-plan steps and bulk sweeps → Sonnet `implementer`; no-judgment → Haiku `checker` (lint + tsc stay direct); external tools per `~/.claude/external-io.md`, injected on the first MCP call; Fable: plans, code on yes; the harness advisor only when stuck or before an irreversible / architectural commitment, never routine. Spec `~/.claude/subagent-tiers.md`, injected on the first Agent call; `hooks/enforce-subagent-model.sh` enforces.
- **Never stop in-flight work on inferred intent.** A running agent or task stops only on an explicit "stop" / "kill" / "cancel"; a request about what comes next (fresh session, new plan, handoff) gets the running list and "stop or let it finish?". TaskStop discards the agent's work. A peer session is messaged and stops its own process; a stray port holder stops by PID from `lsof -tiTCP:<port> -sTCP:LISTEN`, never a pattern kill.

## Config & harness
- **Editing `~/.claude` (rule docs, hooks, settings)? `~/.claude/harness.md` owns the maintenance rules** — `hooks/harness-context.sh` injects its Maintenance section on the first write under `~/.claude` each session.
- **Review depth: `~/.claude/review-routing.md` owns it** (hook-injected on review asks) — battery only when named, never proactively.
- **Classifier or hook denial = stop and ask, never route around.** Actual denials only — an anticipated block with a sanctioned exit (`ExitWorktree`) is executed. On one: finish independent work, hand me the exact blocked action, stop; I retry via `/permissions`, exiting auto mode, or `!`. After my yes, report that action only, never re-ask; the grant unblocks only it, and my typed ask still sets the plan. No smaller pieces or alternate tool unless the denial names the route.
- **`<private>…</private>` = use now, never persist.** Content inside the tags never lands in memory files, .remember/, CLAUDE.md, commits, or any artifact — reference it this session only.
- **Ask before writing, moving or deleting outside the repo, or a file I placed.** Raise the concern first, then wait. A repo secret stays put, gitignored. Publishing to claude.ai Artifacts counts; an unasked visual goes to a local file and the reply gives the path.

## Tooling gotchas
- **zsh: quote grep globs** — `hooks/block-dangerous-git.sh` auto-quotes unquoted `--include=*`; an empty grep is unverified until the command exited 0.
- **Edit corrupts on `$'` in `new_string`** — it is read as a replace pattern and splices in the file's tail. Split the edit so `$` ends a `new_string`.
- **Lockfiles: never full-regen to clean** (deleting one is hook-denied). Lockfile diff far bigger than change = diff resolved-version set before trusting.
- **Library APIs key on the installed version.** Every API claim cites `pkg@x.y.z` + source — none = lookup skipped. Lookup ladder: `~/.claude/library-docs.md`, injected on the first package import written, web search or docs fetch.
- **Browser verification** — `~/.claude/browser-verify.md`, injected on the first chrome-devtools call.
