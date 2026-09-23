# Review battery — recipe (read only on the `battery` verb)

| Member | Tier |
|---|---|
| pr-review-toolkit:code-reviewer, silent-failure-hunter, type-design-analyzer, reuse-analyzer, placement-analyzer | session (model omitted) — multi-hop lenses; the tier hook injects opus if the session is below it, so the battery cannot silently drop tier |
| comment-analyzer, modern-ts-analyzer | `model: "opus"` — single-pass lenses; still review work, so Opus and never the Sonnet mechanical tier |
| pr-test-analyzer | `model: "opus"`; only when package.json scripts has a test runner — a "missing tests" nag on a repo with no suite is noise |

- HIGH risk flagged by the routing hook → add the harden set (adversarial-reviewer + security-review on the main thread, silent-failure-hunter + type-design-analyzer already members). Bulk flagged → add /delete-list + /shortcut-debt (comment- and modern-ts-analyzer already members). Neither flag → the eight above, nothing more.
- All output is leads; confirm each at source before relaying.
- Open: re-run the Opus-vs-session A/B on a frozen diff before moving the multi-hop members to Opus; a diff that moves mid-run invalidates the comparison.
