# Harness maintenance

Injected by `hooks/harness-context.sh` once per session, on the first Write/Edit under `~/.claude/` or of any `CLAUDE.md` / `CLAUDE.local.md` / `.claude/` path, or a write-shaped Bash command naming `~/.claude` (`projects/` memory and `plans/` excluded). The once-flag is per session, so a subagent editing after the parent triggered never sees it — the dispatcher owns the verify gate.

## Maintenance
- **Harness tests: `node --test ~/.claude/tests/*.test.js` after any edit to CLAUDE.md, a rule doc, a hook, or settings hooks.** Checks pointers resolve, frontmatter, hook syntax, rule↔hook agreement, always-load word ceilings (`tests/budget-baseline.json`), and duplicated sentences across rule docs. Red = fix the drift or raise the baseline deliberately, never allowlist.
- **One tier owns a rule.** Layered config (global CLAUDE.md → framework ref → project memory): general principle lives in exactly one tier; others hold pointer or specific instance. Promote/demote = move + pointer, never copy.
- **Hydrogen guidance is repo-gated — never add unconditional Hydrogen rules here.** `hydrogen.md` loads only via a Hydrogen repo's `CLAUDE.local.md` import; `hooks/hydrogen-context.sh` and `hooks/hydrogen-util-guard.sh` exit unless the toplevel `package.json` depends on `@additiv-hydrogen`.
- **Hook output channels: plain stdout never reaches the model.** Only exit 2 + stderr (blocking) or JSON `hookSpecificOutput.additionalContext` (advisory) does — a stdout-printing PostToolUse hook runs silently for months. **`if` gates the process spawn per subcommand** (`a && b` matched separately); a script guarding several command families needs one `if` entry per family, or the unlisted families never run.
- **Plugin curation record = `~/.claude/plugin-curation.md`** — read before touching `enabledPlugins`; `false` entries are deliberate tombstones, curation reverts on plugin updates, usage oracle = transcripts not name-greps.

## Figma MCP
- **Figma MCP `download_assets`: commit the `export`, never `svgAssets`.** `svgAssets` drops instance transforms — a rotated or flipped instance comes back wrong and nothing downstream can tell. `export` (`defaultFormat: "svg"`) is the whole-node render (frame, offset, rotation, background rects to strip); it is `null` and `get_metadata` says "invalid node selection" unless the node's page is open in Figma desktop.
