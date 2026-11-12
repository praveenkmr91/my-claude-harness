# Subagent model tiers — Fable sessions and enforcement (continues `subagent-tiers.md`)

## Fable sessions

- **Fable is never the writer.** A Fable main thread writes docs, config and plan files directly and dispatches every source edit to `implementer`, except harness files under `~/.claude/` (plugin caches aside), which it writes itself; Fable is never placed on `implementer` or any worker, with no override. Its own source writes are lifted for one turn by `[tier-override: <why>]` in the typed prompt. Fable reviews **plans** on its own authority and reviews **code** only on Praveen's say-so (the Fable pool is metered separately; the review tier is Praveen's call, never inherited). Praveen rarely asks unprompted, so the move is mine to propose when a diff earns it — HIGH risk plus bulk, or a finding Opus already missed once — with the cost named; Praveen's yes is the approval. The ask or the yes has to arrive as its own typed prompt: a message sent mid-turn is not stored as a turn.
- **Fable plan consult** goes only onto the `Plan` agent, from an Opus-or-above main thread: for every plan when the advisor is unavailable, and outside plans only when the decision is irreversible, money-moving, or one Opus already got wrong once; `plan-build.md` owns where in the plan flow it runs. A typed consult ask ("consult fable", "fable opinion") is also dispatched as `Plan`, which cannot write; `general-purpose` can, so Fable on it is denied even with the ask. Ad-hoc shapes need `[tier-override: <why>]`.
- **A worker never dispatches Fable**, not even with a tier-override, and neither does a session below Opus. A worker that wants a Fable opinion finishes what it can and ends its turn with the question for the dispatcher — the decision, the options, what needs ruling on; the dispatcher takes the call.

## Enforcement

Mechanics and escapes live in the hooks' own comments and deny text; this section names only what each hook decides.

- `hooks/enforce-subagent-model.sh` (Agent) denies a dispatch with no `subagent_type`, a model above the session tier (a review/planning agent may name opus), Sonnet or Haiku on a review/planning agent, and Fable outside the Fable rules above. A Fable code review opens only on Praveen's typed ask or a yes to a reply ending `Fable review?` / `Fable battery?`; a passing mention is not an ask. With `model` omitted it places Explore and review agents itself (table in `subagent-tiers.md`). From an Opus session it denies a model-less `general-purpose`, so `/simplify` and `/security-review` agents, which are review work, are dispatched with `model: "opus"`.
- `hooks/opus-write-nudge.sh` (Write|Edit, main thread, Opus or above) blocks every source write in a Fable session, and an Opus session's first source write of every turn until `implementer` is dispatched; harness files under `~/.claude/` pass both arms, plugin caches excepted. Source means code, not docs or config. `bash-write-guard.js` relays `sed -i`, `perl -pi`, `git mv` and `git rm` on code (a moved folder by its contents, an xargs- or `find -exec`-fed `sed` by its working directory) to the same gate.
- `hooks/inline-call-nudge.sh` enforces CLAUDE.md "Direct tool": it nudges from the 4th direct lookup since the last typed prompt, agent dispatch or write.
- Everything fail-opens on an unreadable transcript or unknown session model, except Fable, which **fails CLOSED**. `[tier-override: <why>]` lifts any denial deliberately, except a worker reaching for Fable and a dispatch with no `subagent_type`, both unconditional.

## Principle

Use the cheapest tier whose oracle is strong enough for the decision; pay for a higher tier only where a wrong answer is expensive to discover later.
