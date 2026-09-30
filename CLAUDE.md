# Global Claude Code Preferences

## Who I work with
- **Role.** Principal engineer / architect at additiv, frontend R&D.
- **Stack.** Web frontend (JS/TS — React, Next, Vue, Angular) + mobile (Swift, Kotlin, Flutter). NOT backend/systems (Go, Rust, Java, Python, .NET, SQL). Agent/plugin/tooling recommendations scoped to frontend+mobile.
- **Voice.** Owned by the `peer-engineer` output style + persona hook. Tight but complete: full sentences, one line per point — "too verbose" and "too clipped" are both misses. Depth only when explicitly asked.

## Before writing code
- **No new conventions when one exists.** Codebase already answers → never invent.
- **Gate = irreversible or architectural only.** New dep, new layer/boundary, 2+ defensible approaches, destructive op → state approach 2-3 lines, get yes/no. Everything else: proceed, state what you did. Full brainstorm only for truly ambiguous/greenfield.
- **Planning = plan file, any mode.** 3+ files or gate above → draft in `~/.claude/plans/` first; the write loads plan-mode rules.
- **Dispatch proactively — decide, don't ask.** Explore/research/verify agent would tighten plan → fire it (one-sentence announce, no permission ask). Standing authorization for cheap workers. Plan note "verify X" / "confirm Y" IS trigger — dispatch *before* writing dependent section, not checkbox handed back to user.
- **Organise by cohesion; abstract by reuse.** Layout = cohesion (what changes together) + size — splitting an overgrown file needs no reuse justification. Reuse gates only *extraction* (new package/module/shared helper) — ask what's shared with siblings first. Extraction forcing cross-boundary re-exports (`export … from` holes punched in another module's barrel to reach internals) = boundary misplaced; colocate.
- **Dependency ladder — new dep is last rung.** Before reaching for code: existing codebase helper → stdlib/language built-in → native platform (Intl, `<dialog>`, URL, fetch, CSS) → already-installed dep → only then propose new dep (name cost: bundle, maintenance, supply chain — get yes/no).
- **Layer check.** Before mutation/hook/side-effect: name layer (data / hook / component), verify placement. Uncertain placement = architectural → gate.
- **One-way decisions must latch.** Gate from transient async state (query flags, cache presence, 404-means-absent) re-evaluates every refetch/remount. One-way decision ("workflow exists", "user dismissed", "step completed") → latch (set-once ref/state), never re-derive. Miss symptom: remount/refetch loops, flicker, re-fired side-effects.
- **Ground against sampled reality, never memory.** Code touching an external interface (API, schema, config surface) only after a real sampled response exists; field names, nesting and types come from the sample. Endpoint missing/erroring/permission-denied → report the blocker with exact request+response, never fabricate past it. A 5xx body is evidence about one call, not an execution model — ask the contract owner. A "field is missing" claim needs a recursive key dump of more than one live instance.
- **Sample to falsify, not confirm.** List what would break the rule (rotated, flipped, empty, nested, multi-valued), pull one sample per axis; "exact on N samples" that share an untested property is no evidence.
- **No fabricated data outside tests.** Mocks/fixtures live in test dirs only, payloads copied from real captured responses with provenance comment. Genuinely unwireable → visible "not wired" stub + recorded assumption (claim / risk-if-wrong / how-to-verify), never silent plausible fake.
- **Reused code keys on identity — verify which value wins; swapping → fork ALL seams.** Look-alike hook/component often binds identity (route id, cache key, workflow name, DI token) at init from a fixed const — override silently ignored, failure surfaces far from the reuse point.

## Code craft — write like a human, not vibe-coded
- **Comments = footguns only — default to ZERO.** Write none first; add one only when you can name the specific wrong edit/assumption it prevents (bar = a future reader trips without it, NOT "was non-obvious to me while writing"). State the trap, not the history: no essays, no labels on obvious blocks, no justifying absent code, no explaining library internals, no restating the code, no repeating the same why across sibling files. Land the right density on the FIRST pass.
- **No premature abstraction.** Inline until 3+ real repetitions — config array + `.map` over 2 items = vibe-coded.
- **No speculative generality.** Every param/option/prop/type-param needs a caller that passes it today. "Might need it" = delete it; add when the second caller exists. Exception — shared UI-component library: its contract is the design spec plus the generic surface popular libs expose (`className`, rest props, `ref`, optional slots); caller count never adds, keeps or removes a prop there.
- **Guard real states, not impossible ones.** Optional-chain/null-check only where the type or contract says nullable; no try/catch around non-throwing code. Over-defense hides the actual contract and reads machine-generated.
- **Name by intent.** `clearErrorOnChange`, not `handleChange`.
- **Readable over terse. Fewer lines ≠ better.** Keep named single-use intermediates (`const isValid = await trigger()`) — say what value means, read top-to-bottom. Never fold into nested expression to save line.
- **Name qualifiers: strip on files, keep on shadowing symbols.** Filename disambiguated by path — don't repeat qualifier location implies (`review-step.tsx` inside `custom/…`, never `custom-review-step.tsx`). Exported symbol travels to import site path-stripped → KEEP qualifier when shadows base export same name (`CustomModifyInvestment` next to base `ModifyInvestment`).
- **Swapping hand-rolled code for wrapper: keep its guards.** Wrapper often *throws* where local code degraded gracefully (date-fns `format` on Invalid Date; ICU `currency()` on bad code). Replacing hand-rolled formatting/parsing/math → carry over null-guard / try-catch / fallback. "Modernizing" must not silently drop error handling.
- **Error states load-bearing — never absorb silently.** Every query/mutation consumer renders or propagates error state. Every catch: surface (user-visible message/retry), rethrow, or log-with-intent — never bare-swallow. Fallback value in catch = product decision, not default: state what user sees when fires.
- **Deliberate shortcut = tagged, never silent.** Cutting a corner on purpose (naive impl, missing edge, deferred hardening) → one-line `shortcut:` comment naming limitation + upgrade path. Passes the footgun bar; untagged shortcut reads as oversight. Ledger: `/shortcut-debt`.
- **Surgical on build tasks.** Every changed line traces to the ask; adjacent code, comments, formatting untouched. Remove only what YOUR change orphaned; pre-existing dead code → mention, never delete. Holistic sweeps only on an explicit review/simplify ask.
- **Money never binary float.** Amounts = decimal/minor-integer types; formatting is the only float boundary. Money-moving mutation: invalidate-and-refetch, never optimistic; disable submit while pending.
- **Renames stop at serialization boundaries.** Rename/refactor sweeps touch local identifiers only — never DTO/serialized fields, API routes, DB columns, i18n keys, env-var names, public exports. Boundary-crossing name = contract, not style.
- **A11y is write-time, not audit-time.** Interactive = native element (`button`/`a`/`label`), never clickable `div`. Every input labelled. Focus managed on modal/menu open/close. ARIA only where semantics can't reach. Periodic audit = backstop, not mechanism.

## Before claiming done
- **After every code change:** run linter + type checker before declaring done. Static-clean (lint+tsc) ≠ "done" — exercise change at runtime before claiming works. The ticket's worked example IS the acceptance test: replay it end-to-end at runtime before claiming fixed; if it can't pass under the chosen design, that's a design finding to raise before shipping.
- **Self-review diff through Code-craft lens before commit — required gate, not polish.** Lint + tsc + code-review passing ≠ reading like human. Delete-list first: what can go before what should change. Watch: comment bloat, same *why* stated twice. Inline for small diffs.
- **Right-size inherited/sibling boilerplate — one holistic sweep.** Per mirrored piece: load-bearing THIS case, or inherited? Drop what isn't. Review/simplify = ONE ranked simplify+correctness sweep, never reactive piecemeal.
- **Automated sweeps prove behavior preserved, or revert.** Comment/whitespace-only cleanup → `npx esbuild <file> --minify-whitespace` pre/post must byte-match (strips comments+whitespace; any diff = sweep touched code). Anything deeper (renames, restructures) → full verify gate; any red = revert the whole sweep, not patch forward.
- **No FE workarounds for BE contract gaps.** Poll/retry shims and client-side patches for a wrong or missing backend contract are not built — comment the exact ask on the ticket and block.
- **Stakeholder-facing text is concise, not terse.** Jira comments, PR descriptions, commit bodies: root cause in 2-3 sentences, the ask in 1-2, nothing else — no verification narratives, probe timings, or trade-off essays. Full sentences a reader without session context can follow; cut padding, never connective tissue.

## Committing
- **Never commit without explicit approval.** Show diff, wait for yes.
- **Pathspec commits when tree has concurrent in-flight work.** Shared branch carrying staged/unstaged changes from other tasks → commit explicit pathspec (`git commit --only <dir>/`), unrelated work untouched. Shared wiring files (package.json, lockfile, routes) → leave to owner.
- **No attribution trailers in commits or PRs.** Enforced by `hooks/block-dangerous-git.sh` (denies `Co-Authored-By` / "Generated with" / tool footers at PreToolUse); do not copy trailers from `git log`.

## Delegating
- **Subagent:** open-ended research (3+ queries), specialized fits (Explore, implementer, checker, external-io, code-reviewer, frontend-design), 2+ independent parallel investigations. An omitted `model` inherits the session tier — dispatch a declared cheap agent rather than a bare `general-purpose`, or mechanical work burns Opus silently.
- **Direct tool:** known target (file path → Read, symbol → Grep), ≤3 parallel calls.
- **Anti-pattern:** subagent to read one known file.
- **Model tier by work KIND.** Spec: `~/.claude/subagent-tiers.md`; `hooks/enforce-subagent-model.sh` enforces.
  - Brain work (review, architecture, planning, debugging) → Opus or above. Sonnet or Haiku on a review/planning agent is denied; from a sub-Opus session the hook injects Opus.
  - Code carrying a design call → Opus, written directly.
  - Approved-plan steps (every name, prop shape and path already settled in the plan) and bulk mechanical sweeps → Sonnet `implementer`, one step or slice per dispatch; Opus then reviews the diff, applies the review's fixes itself, and runs the verify gate.
  - No-judgment work (test suite, `check:*`, build, listings, censuses) → Haiku `checker`, however short; only lint + tsc stay direct. Explore → Haiku always.
  - Unbounded external tool work → `external-io` (Sonnet) or `fork`; one bounded read stays inline.
  - Fable reviews plans only — never writes or reviews code, Opus-main-thread onto `Plan`; a subagent never reaches it and returns the question to the dispatcher. Escalation is tagged `[tier-override: <why>]`.

## Config & harness
- **Editing `~/.claude` (rule docs, hooks, settings)? `~/.claude/harness.md` owns the maintenance rules** — `hooks/harness-context.sh` injects it on first contact with `~/.claude` each session.
- **Review depth: `~/.claude/review-routing.md` owns it** (hook-injected on review asks) — battery only when named, never proactively.
- **Classifier or hook denial = stop and ask, never route around.** On a classifier block or hook-refused tool call: finish independent work, hand me the exact blocked action in one message, stop — I retry via `/permissions` → Recently denied, exiting auto mode, or `!`. No smaller pieces, no alternate tool — unless the denial names the sanctioned route.
- **`<private>…</private>` = use now, never persist.** Content inside the tags never lands in memory files, .remember/, CLAUDE.md, commits, or any artifact — reference it this session only.
- **Ask before writing, moving or deleting outside the repo, or a file I placed.** Raise the concern first, then wait. A repo secret stays put, gitignored.

## Tooling gotchas
- **zsh: quote grep globs.** Unquoted `--include=*.tsx` dies as "no matches found" before grep runs, and the empty result reads as "nothing exists". Always `--include='*.tsx'`; an empty grep is unverified until the command exited 0.
- **Lockfiles: never full-regen to clean.** Drop removed dep: surgically delete stanza (`file:` local entries have no integrity hash) or `npm install --package-lock-only` — never `rm lock && install`, re-pins every `^`/`~` to today's registry (silent toolchain drift). Lockfile diff far bigger than change = diff resolved-version set before trusting.
- **Library APIs key on the installed version.** Resolved version from the lockfile (`package.json` only a range; `node_modules` disagreeing = stale). Every API claim cites `pkg@x.y.z` + source — none = lookup skipped. Ladder: `~/.claude/library-docs.md`.
- **Browser verification: no routine screenshots.** `take_snapshot` (a11y tree) for structure/labels/state, `evaluate_script` geometry assertions (`getBoundingClientRect`, `elementsFromPoint`, computed z-index) for exact visuals, console for errors. Screenshot only on explicit ask or Figma-vs-build diff at UI done-check (`external-io` reports differences+severity+location).
