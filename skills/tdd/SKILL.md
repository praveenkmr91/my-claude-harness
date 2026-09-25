---
provenance: condensed 2026-09-25 from superpowers 6.4.1 skills/test-driven-development (cycle) + affaan-m/ECC@e482e57 skills/tdd-workflow (RED gate) and skills/react-testing (React defaults); neither installed, see ~/.claude/plugin-curation.md
name: tdd
description: Use when writing or changing logic that can fail silently — custom hooks, data transforms, money math, parsers, validation, state machines — or when fixing a bug (write the reproducer first). Not for JSX layout, styling or copy changes.
---

# Test-first for logic

Tests first where a wrong answer renders fine and nobody notices: hooks, transforms, money math, parsers, validation. Layout and styling are verified at runtime, not test-first.

## Match the repo first
Read two sibling test files before writing one: runner, file location, query style, mock setup. Resolve the runner from `package.json` scripts and the lockfile; never assume `npm test`. The React defaults below apply only where the repo has no convention.

## Cycle
1. **RED.** Write one test for the next behaviour. Run it. It counts as RED only if it compiled, actually executed, and failed for the intended reason — the missing behaviour or the bug. A failure from an import, setup or typo is not RED; fix the test and rerun. A test never run is not RED.
2. **No production edit before RED.** For a bug fix, the reproducer failing on the reported input is the RED.
3. **GREEN.** Minimal code to pass. Rerun the same target and see the previously failing test pass.
4. **Refactor** while green; rerun after each change.
5. Next behaviour.

## Plan handoff
Each behavioural plan step maps to one test target; that step's `→ verify:` is the test command. Choosing which behaviours to guarantee and writing the RED tests stays on the main thread — `implementer` only receives "make these green".

## React defaults
- Query by role or label (`getByRole('button', { name: /save/i })`); `getByTestId` is the last resort.
- `const user = userEvent.setup()` once per test; `await` every interaction. Prefer `userEvent` over `fireEvent`.
- Async: `findBy*`, `waitFor`, `waitForElementToBeRemoved`. Never `setTimeout` plus an assertion.
- `queryBy*` only to assert absence.
- Render with production providers. Never mock React; mock a child only when it has heavy side effects.
- `act()` warnings are real bugs (update after unmount, unawaited async), not noise.
- Snapshots only for pure serializers, never rendered components.
- Real layout, scrolling, drag-and-drop, clipboard, iframes → Playwright, not JSDOM.

## Network mocks
Mock at the network layer with the repo's existing tool, payloads per the CLAUDE.md "No fabricated data" rule.

## Done means
Every new behaviour has a test that was seen failing, then seen passing, in this session. No coverage target — a test that never failed proves nothing.
