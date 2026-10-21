# External tool work — routing spec (pointer lives in CLAUDE.md "Model tier by work KIND")

Any MCP server or external CLI — Jira, Figma, Chrome DevTools are examples, not the list — is routed by call shape, never by a guess at payload size.

- **Unbounded calls run on a worker**: comment threads, JQL or CQL search, any listing, Figma file or node reads, multi-call pulls. The worker is the `external-io` agent (Sonnet; the dispatcher checks any geometry or field names it distils against the saved raw slice), or `fork` for an ad-hoc job (session tier, full context). A read that asks for comments or lists is unbounded even when this instance happens to be small.
- **All browser work runs on `browser-verifier`**, enforced by `hooks/browser-main-guard.sh`; the escape is Praveen's typed `[browser-inline: <why>]`. A `fork` may debug in the browser, but the Stop gate counts only a `browser-verifier` run as evidence, so the fix is verified on `browser-verifier` after the fork.
- **One bounded read stays inline**: a single issue with `fields` restricted and no comments, one account-ID lookup, one schema load. A spawn costs more than that payload and returns a summary where the source was wanted.
- **Raw before summary**: the dispatcher passes a scratchpad path for saved slices, and a raw sample that code will depend on comes back as a saved file, never a summary.
- **Outward writes** are approved on the main thread first; the worker executes only that exact payload. One browser worker at a time.
- **A worker's classifier denial is never retried** by relaying "user approved" over SendMessage — the classifier reads that as Auto-Mode Bypass. The main thread runs that one step itself, where the user approves it directly, then resumes the worker. For a browser step, the main thread runs it once Praveen's typed turn carries `[browser-inline: <why>]`; the reply asks for it by that phrase.
