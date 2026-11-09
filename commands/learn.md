---
description: Extract the most reusable lesson from this session, check it against every config tier, then Absorb / Save / Drop it
---
<!-- adapted from affaan-m/ECC@e482e57 commands/learn-eval.md -->

1. **Pick one lesson** from this session: a corrected mistake, a non-obvious root cause, a tool or library quirk, a convention confirmed by the user. Skip typos, one-off outages and anything the repo or git history already records.

2. **Overlap check.** Grep by keyword, and read the hits, across:
   - `~/.claude/CLAUDE.md` and the rule docs it points to
   - `~/.claude/skills/*/SKILL.md` and `~/.claude/commands/`
   - project memory (`MEMORY.md` and its files) and the repo's `CLAUDE.md` / `CLAUDE.local.md`

3. **Verdict — exactly one:**
   - **Absorb into `<file>`** — default. The lesson sharpens a rule some tier already owns; edit that rule in place.
   - **Save** — no owner exists. Memory file when it is a fact about the user, project or a reference; a skill only when it is a repeatable procedure.
   - **Drop** — trivial, one-off, or already covered as written.

   Pick the tier by reach: every project → global; one framework → framework ref; one repo → project memory.

4. **Show** the checklist results, the verdict with a one-line reason, and the exact diff or new file. Write only on yes. Drop needs no confirmation.

**`/learn report`** (`$ARGUMENTS` is exactly `report`): walk the weekly batch's reports instead of this session. Read every `~/.claude/state/learn/[0-9]*.md` newer than `~/.claude/state/learn/acked`, oldest first; none → say so and stop. Per report, take each `## Absorb` and `## Save` proposal in order: show its verdict, evidence and diff, write only on yes, skip on no; `## Dropped` lines are shown once, never acted on. After the last report, `touch ~/.claude/state/learn/acked`.
