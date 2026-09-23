# Plugin curation — global record

Owns deliberate `enabledPlugins` decisions in `~/.claude/settings.json`. Check here BEFORE touching `enabledPlugins`. Sweep research, SKIP verdicts for never-installed candidates, and hook/CLI findings live in `~/.claude/ecosystem-research.md` (archive) — this file holds only current state and the why behind it.

**Maintenance rule:** the tables below must match `enabledPlugins` at all times. A reversal edits the row in place (new date + reason) — never leave a stale row beside a new one.

**Policy (2026-07-28): minimal always-on core; everything episodic is OFF by default, enabled on demand.** On-demand = `/plugin` toggle (+ restart) for a one-off, or per-repo `.claude/settings.local.json` for a project that consistently needs it. There is no lazy loading — enablement is startup-time. Superpowers and browser tooling are NOT plugin-borne: see Localized below, and the user-scope `chrome-devtools` mcpServer in `~/.claude.json`.

## Always-on core (`true`) — earns its slot through constant use
| Plugin | Note |
|---|---|
| `typescript-lsp@claude-plugins-official` | — |
| `context7@claude-plugins-official` | — |
| `remember@claude-plugins-official` | — |
| `pr-review-toolkit@claude-plugins-official` | — |
| `frontend-design@claude-plugins-official` | — |
| `claude-md-management@claude-plugins-official` | — |
| `impeccable@impeccable` | — |
| `security-guidance@claude-plugins-official` | Pattern-only since 2026-09-04: `env.ENABLE_CODE_SECURITY_REVIEW="0"` disables its Opus Stop/commit review (secret-leak bug `anthropics/claude-code#90010`). Verify after restart: `~/.claude/security/log.txt` gains no `Stop hook:` lines. Revert when #90010 closes. Narrower: `ENABLE_STOP_REVIEW=0` (keeps commit review, same leak surface); kill switch `SECURITY_GUIDANCE_DISABLE=1`. |
| `commit-commands@claude-plugins-official` | Only `/clean_gone` earns it; `/commit` conflicts with never-commit-without-approval. Revisit if it misfires. |
| `claude-hud@claude-hud` | Added 2026-08-24. Pure `statusLine`, zero context/network cost. The hand-rolled predecessor's `.bak` no longer exists — rollback = disable + write a new `statusLine`. |

## Tombstones (`false`, kept installed) — deliberate, do NOT "clean up"
| Plugin | Since | Why |
|---|---|---|
| `modern-web-guidance@googlechrome` | 2026-09-23 | ~0 real invocations in 29 days always-on; "MANDATORY execute FIRST" description cost ~1k tok/session. Dependency-ladder rule + context7 cover it. `googlechrome` marketplace kept — re-enable via `/plugin` if a native-platform task shows it'd have helped. |
| `code-simplifier@claude-plugins-official` | 2026-09-20 | Duplicate of `pr-review-toolkit:code-simplifier`; `trim` verb uses `/simplify`. |
| `superpowers@superpowers-dev` | 2026-07-28 | Its SessionStart hook injected ~1.4KB regardless of `skillOverrides`; used skills localized (below). |
| `superpowers@claude-plugins-official` | 2026-06-18 | Duplicate build. |
| `explanatory-output-style@claude-plugins-official` | 2026-07-28 | Injects via SessionStart regardless of `outputStyle` — fights the peer-engineer persona. |
| `caveman@caveman` | 2026-07-28 | 1 use ever; third competing persona injection. |
| `figma@claude-plugins-official` | 2026-07-28 | 0 real uses (hits were listing noise). Re-flipped to `true` once by a `/plugin` reinstall. The claude.ai Figma connector is separate and heavily used. |
| `chrome-devtools-mcp@claude-plugins-official` | 2026-07-28 | Browser-stack triplication; user-scope `chrome-devtools` server is the workhorse. Re-enable for its debugging skills (memory-leak, LCP, a11y). |
| `playwright@claude-plugins-official` | 2026-07-28 | Same triplication. |
| `investment-banking@claude-for-financial-services` | 2026-07-28 | 0 uses, 16 skills. |
| `atomic-agents@claude-plugins-official` | 2026-06-18 | Python framework, off-stack. |
| `skill-creator@claude-plugins-official` | 2026-06-18 | Unused; account-side `anthropic-skills:skill-creator` covers it. |
| `firecrawl@claude-plugins-official` | 2026-06-18 | Unused. |
| `swift-lsp@claude-plugins-official` | 2026-06-18 | Enable per-repo when a Swift repo is active. Also disabled in ATRAM via `.claude/settings.local.json`. |
| `kotlin-lsp@claude-plugins-official` | 2026-06-18 | Enable per-repo when a Kotlin repo is active. |

## Fully purged (settings key, `installed_plugins.json`, cache, and marketplace where it had its own)
| Plugin | When | Re-add |
|---|---|---|
| voltagent-lang@voltagent-subagents | 2026-06-18 | `/plugin marketplace add VoltAgent/awesome-claude-code-subagents` |
| chrome-devtools-plugins marketplace | 2026-06-18 | `/plugin marketplace add ChromeDevTools/chrome-devtools-mcp` |
| ralph-loop | 2026-07-28 | `/plugin` (native `/loop` covers it) |
| warp@claude-code-warp | 2026-07-28 | `/plugin marketplace add warpdotdev/claude-code-warp` |
| GSD suite (local skills/agents/hooks, not a plugin) | archived 2026-07-28, deleted 2026-09-23 | reinstall from upstream |

A key-deleted-but-still-installed plugin is an untested enablement state — tombstone (`false`) or purge fully, never in between.

## Localized instead of installed (copies FREEZE at copied version; provenance in each SKILL.md frontmatter)
- `systematic-debugging`, `verification-before-completion` — from superpowers (2026-07-28). Refresh = re-enable plugin, diff.
- `codebase-design`, `domain-modeling`, `grilling`, `improve-codebase-architecture` — from mattpocock/skills@c55ee46 (2026-09-19). Plugin not installed: ships 25 skills always-on.
- `react-best-practices` — from vercel-labs/agent-skills (2026-07-29), Next.js/RSC rules pruned. Refresh = re-clone + diff.

## claude.ai account connectors and skills
- claude.ai connectors Canva / Excalidraw / Microsoft Learn: 0 calls (2026-09-23), not settable from `~/.claude`. Optional hygiene only — unused connectors surface as deferred names, so disconnecting saves near-zero context. Figma, Claude Docs, Atlassian kept.
- claude.ai account skills: hidden via `skillOverrides` (2026-09-23, 0 uses). docx/xlsx/pptx/pdf `name-only`; negotiation/morning/import-memory `off`. Keep `docs` (Claude Docs connector needs it).

## Mechanics
- **Drift is machine-guarded:** `hooks/plugin-drift-guard.sh` (SessionStart) diffs `enabledPlugins` against `plugin-curation.expected.json` — silent when clean, banner on drift. Deliberate change → `--accept`, then update the tables here. Snapshot is script-written only; never hand-edit.
- **Curation decays on plugin updates AND reinstalls** (voltagent pruning reverted on update; figma flipped by reinstall). Oracle for "why did this flip": `installed_plugins.json` timestamps.
- **Why tombstones are protected:** this record moved here 2026-07-28 from ATRAM project memory, where other projects couldn't see it — that caused a near-miss cleanup of deliberate `false` entries.
- Settings precedence user < project < local: a global `false` is a default, not a lock.
- Plugin changes need a Claude Code **restart**. Disabling does not evict `~/.claude/plugins/cache/`.
- Usage oracle = transcripts (`~/.claude/projects/**/*.jsonl`): grep actual `tool_use`/skill invocations, never bare name hits — skill listings inflate name matches by orders of magnitude.
