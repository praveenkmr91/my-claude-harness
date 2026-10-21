# Browser verification

Injected by `hooks/inject-once.sh` once per thread (main and each subagent), on the first chrome-devtools call.

- **No routine screenshots.** `take_snapshot` (a11y tree) for structure/labels/state, `evaluate_script` geometry assertions (`getBoundingClientRect`, `elementsFromPoint`, computed z-index) for exact visuals, console for errors.
- Screenshot only on explicit ask or Figma-vs-build diff at UI done-check (`browser-verifier` reports differences+severity+location).
- Actions run on `browser-verifier` (`hooks/browser-main-guard.sh`); the main thread reads or selects a page a worker left.
