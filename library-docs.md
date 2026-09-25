# Library docs lookup

A library API is an external interface — CLAUDE.md "Ground against sampled reality" applies. Injected by `hooks/docs-context.sh` once per session, on the first Write/Edit adding a bare-specifier import, or the first WebSearch, context7 call, or non-GitHub WebFetch.

Most accurate first; stop at the first rung that answers:
1. **Version.** The lockfile's resolved entry — `package-lock.json`, `pnpm-lock.yaml` (pnpm `catalog:` ranges resolve in `pnpm-workspace.yaml` + the lock), or `yarn.lock`. Cross-check `node_modules/<pkg>/package.json`; a mismatch means a stale install, so don't read it.
2. **Installed package.** `.d.ts`, README, CHANGELOG under `node_modules/<pkg>/` — the code that actually runs.
3. **Repo docs at the matching tag, raw.** `gh api repos/<o>/<r>/contents/<docs-path>?ref=<tag> -H "Accept: application/vnd.github.raw"`; the tag's CHANGELOG answers "when did X change".
4. **context7, only when pinned.** Only a library ID whose `Versions:` list holds the step-1 version counts. Most IDs list none and serve whatever was indexed — treat that as a hint to confirm at 2-3, never the source.
5. **Versioned docs site** for that major. A WebFetch summary paraphrases; it never settles an API shape alone.

**Upgrading or migrating:** the lockfile still holds the old version, so the target version replaces rung 1 — read the target tag's migration guide and every CHANGELOG entry between the two versions (rung 3). After the install lands, rung 1 resolves the new version again.

Never the source: memory, a search top-hit, a curated cheat-sheet pinned to a different version.
