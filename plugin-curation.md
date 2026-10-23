# Plugin curation — global record

Owns deliberate `enabledPlugins` decisions in `~/.claude/settings.json`. Check here BEFORE touching `enabledPlugins`. This file holds only current state and the why behind it; the sweep research that produced it is in git history (`git log --all -- ecosystem-research.md`).

**Maintenance rule:** the tables below must match `enabledPlugins` at all times. A reversal edits the row in place (new reason) — never leave a stale row beside a new one.

**Policy: minimal always-on core; everything episodic is OFF by default, enabled on demand.** On-demand = `/plugin` toggle (+ restart) for a one-off, or per-repo `.claude/settings.local.json` for a project that consistently needs it. There is no lazy loading — enablement is startup-time. Superpowers and browser tooling are NOT plugin-borne: see Localized below, and the user-scope `chrome-devtools` mcpServer in `~/.claude.json`.

## Always-on core (`true`) — earns its slot through constant use
| Plugin | Note |
|---|---|
| `typescript-lsp@claude-plugins-official` | — |
| `context7@claude-plugins-official` | — |
| `remember@claude-plugins-official` | — |
| `pr-review-toolkit@claude-plugins-official` | `review-pr`, `code-simplifier` unrouted; battery/trim supersede. |
| `frontend-design@claude-plugins-official` | — |
| `claude-md-management@claude-plugins-official` | — |
| `impeccable@impeccable` | — |
| `security-guidance@claude-plugins-official` | Pattern-only: `env.ENABLE_CODE_SECURITY_REVIEW="0"` disables its Opus Stop/commit review (secret-leak bug `anthropics/claude-code#90010`). Verify after restart: `~/.claude/security/log.txt` gains no `Stop hook:` lines. Revert when #90010 closes. Narrower: `ENABLE_STOP_REVIEW=0` (keeps commit review, same leak surface); kill switch `SECURITY_GUIDANCE_DISABLE=1`. |
| `commit-commands@claude-plugins-official` | Only `/clean_gone` earns it; `/commit` conflicts with never-commit-without-approval. Revisit if it misfires. |
| `claude-hud@claude-hud` | Pure `statusLine`, zero context/network cost. Rollback = disable + write a new `statusLine`. Subagent effort comes from upstream `display.showAgentEffort` (0.12.0+, #815), on in `plugins/claude-hud/config.json`. |
| `cc-plugin-you-should-know@builtin` | Added by a Claude Code update. Kept for its "Heads up" risk notices. |

## Tombstones (`false`, kept installed) — deliberate, do NOT "clean up"
| Plugin | Why |
|---|---|
| `modern-web-guidance@googlechrome` | ~0 real invocations in 29 days always-on; "MANDATORY execute FIRST" description cost ~1k tok/session. Dependency-ladder rule + context7 cover it. `googlechrome` marketplace kept — re-enable via `/plugin` if a native-platform task shows it'd have helped. |
| `code-simplifier@claude-plugins-official` | Duplicate of `pr-review-toolkit:code-simplifier`; `trim` verb uses `/simplify`. |
| `superpowers@superpowers-dev` | Its SessionStart hook injected ~1.4KB regardless of `skillOverrides`; used skills localized (below). |
| `superpowers@claude-plugins-official` | Duplicate build. |
| `explanatory-output-style@claude-plugins-official` | Injects via SessionStart regardless of `outputStyle` — fights the peer-engineer persona. |
| `caveman@caveman` | 1 use ever; third competing persona injection. |
| `figma@claude-plugins-official` | Read-only Figma use; only `figma-design-to-code` needed (localized below). Connector is separate, heavily used. |
| `chrome-devtools-mcp@claude-plugins-official` | Browser-stack triplication; user-scope `chrome-devtools` server is the workhorse. Re-enable for its debugging skills (memory-leak, LCP, a11y). |
| `playwright@claude-plugins-official` | Same triplication. |
| `investment-banking@claude-for-financial-services` | 0 uses, 16 skills. |
| `atomic-agents@claude-plugins-official` | Python framework, off-stack. |
| `skill-creator@claude-plugins-official` | Unused; account-side `anthropic-skills:skill-creator` covers it. |
| `firecrawl@claude-plugins-official` | Unused. |
| `swift-lsp@claude-plugins-official` | Enable per-repo when a Swift repo is active. Also disabled in ATRAM via `.claude/settings.local.json`. |
| `kotlin-lsp@claude-plugins-official` | Enable per-repo when a Kotlin repo is active. |

## Fully purged (settings key, `installed_plugins.json`, cache, and marketplace where it had its own)
| Plugin | Re-add |
|---|---|
| voltagent-lang@voltagent-subagents | `/plugin marketplace add VoltAgent/awesome-claude-code-subagents` |
| chrome-devtools-plugins marketplace | `/plugin marketplace add ChromeDevTools/chrome-devtools-mcp` |
| ralph-loop | `/plugin` (native `/loop` covers it) |
| warp@claude-code-warp | `/plugin marketplace add warpdotdev/claude-code-warp` |
| GSD suite (local skills/agents/hooks, not a plugin) | reinstall from upstream |

A key-deleted-but-still-installed plugin is an untested enablement state — tombstone (`false`) or purge fully, never in between.

## Localized instead of installed (copies FREEZE at copied version; provenance in each SKILL.md frontmatter)
- `systematic-debugging`, `verification-before-completion` — from superpowers. Refresh = re-enable plugin, diff.
- `codebase-design`, `domain-modeling`, `grilling`, `improve-codebase-architecture` — from mattpocock/skills. Plugin not installed: ships 25 skills always-on.
- `react-best-practices` — from vercel-labs/agent-skills, Next.js/RSC rules pruned. Refresh = re-clone + diff.
- `tdd`, `/learn` — from superpowers + affaan-m/ECC; ECC not installed.
- `figma-design-to-code` — verbatim from the figma plugin.
- `tailwind-v4` — from mastra-ai/mastra, near-verbatim; no vendor skill exists; v4 repos only. Refresh = re-pull, diff.
- `delete-list`, `delete-audit`, `shortcut-debt` — from DietrichGebert/ponytail v5.3.2, provenance in each file's header comment. Refresh = diff upstream `skills/ponytail-{review,audit,debt}`. Not installed: its ladder duplicates CLAUDE.md, its band claude-hud.

## claude.ai account connectors and skills
- claude.ai connectors Canva / Excalidraw / Microsoft Learn: 0 calls, not settable from `~/.claude`. Optional hygiene only — unused connectors surface as deferred names, so disconnecting saves near-zero context. Figma, Claude Docs, Atlassian kept.
- claude.ai account skills: hidden via `skillOverrides` (0 uses). docx/xlsx/pptx/pdf `name-only`; negotiation/morning/import-memory `off`. Keep `docs` (Claude Docs connector needs it).

## Mechanics
- **Drift is machine-guarded:** `hooks/plugin-drift-guard.sh` (SessionStart) diffs `enabledPlugins` against `plugin-curation.expected.json` — silent when clean, banner on drift. Deliberate change → `--accept`, then update the tables here. Snapshot is script-written only; never hand-edit.
- **Curation decays on plugin updates AND reinstalls** (voltagent pruning reverted on update; figma flipped by reinstall). Oracle for "why did this flip": `installed_plugins.json` timestamps.
- **Why tombstones are protected:** this record moved here from ATRAM project memory, where other projects couldn't see it — that caused a near-miss cleanup of deliberate `false` entries.
- Settings precedence user < project < local: a global `false` is a default, not a lock.
- Plugin changes need a Claude Code **restart**. Disabling does not evict `~/.claude/plugins/cache/`.
- Usage oracle = transcripts (`~/.claude/projects/**/*.jsonl`): grep actual `tool_use`/skill invocations, never bare name hits — skill listings inflate name matches by orders of magnitude.
