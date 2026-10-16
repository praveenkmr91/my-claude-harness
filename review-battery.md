# Review battery — recipe (read only on the `battery` verb)

| Member | Tier |
|---|---|
| pr-review-toolkit:code-reviewer, silent-failure-hunter, type-design-analyzer, reuse-analyzer, placement-analyzer | session (model omitted) — multi-hop lenses; the tier hook injects opus if the session is below it, so the battery cannot silently drop tier |
| comment-analyzer, modern-ts-analyzer | `model: "opus"` — single-pass lenses; still review work, so Opus and never the Sonnet mechanical tier |
| pr-test-analyzer | `model: "opus"`; only when package.json scripts has a test runner — a "missing tests" nag on a repo with no suite is noise |

- Members run on Opus even from a Fable session; the tier hook places them there unless Praveen's last typed turn contains `fable battery` or says yes to a reply that ends a sentence with `Fable battery?`, the reserved phrase the hook keys on. Propose it only when the diff earns it, cost named.
- HIGH risk flagged by the routing hook → add adversarial-reviewer + security-review on the main thread. Bulk flagged → add /delete-list + /shortcut-debt. Neither flag → the members above, nothing more.
- The launch line names the diff under review (e.g. "plan commit `00b1bfa5`, local, no PR"): the `pr-review-toolkit:` prefix is only the plugin the agents ship in, and it reads as a PR flow when no PR exists. Praveen, 2026-10-14: "the name was a bit misleading".
- All output is leads; confirm each at source before relaying.
- Open: re-run the Opus-vs-session A/B on a frozen diff before moving the multi-hop members to Opus; a diff that moves mid-run invalidates the comparison.
