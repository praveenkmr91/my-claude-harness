# @additiv Hydrogen — shared pointers

Cross-project framework reference for `@additiv-hydrogen/*` frontends, imported by each project's `CLAUDE.local.md`. Framework knowledge only; app facts stay in project memory.

**Every const/path/hook shape below is "where to look," not gospel** — they drift on package bumps; verify against source first (*Source-vs-installed*). Last full source-audit: **2026-07-09**. Re-audit tripwire: any `@additiv-hydrogen/*` version bump → re-verify the pinned facts (page-size defaults, `keepPreviousData` hook list, `exports` maps, dist paths), regenerate the HERA component map, and update this date.

## Paths — grep here BEFORE writing any util/hook/component
- **Hydrogen monorepo (canonical source, READ-ONLY for us — grep it, never edit or PR it; fixes to Hydrogen itself are an ask to its owners):** `~/Documents/projects/hydrogen/hydrogen/` — `data/` (hooks: `gql/`, `services/`, `wealth/`, `wealth-client/`, `credit/`), `ui/` (components, layouts, workflow), `widgets/` (prebuilt `wealth.*`/`wealth-client.*`), `core/` (utils, i18n, router, rest, gql, di), `contracts/` (types). Compiled `node_modules` misses types & unexported helpers — read source. "Hydrogen" in an ask means this monorepo — never the app's vendored `src/core/additiv-hydrogen` copy or an app repo that consumes Hydrogen.
- **Component discovery goes MAP-FIRST:** `~/Documents/projects/hera/.claude/skills/generate-component-map/assets/hydrogen-component-map.json` (288 packages: import paths, exports, props, enums) — shortlist there, THEN verify the pick in source/dist. Monorepo grep is the fallback. Regenerate it via hera's `/generate-component-map` when it trails installed versions.
- **Page layout copies a Hydrogen widget of the same shape** (`ls widgets/*`): its wrappers, box props, headings, separators and gaps. App siblings and hand-picked classes are invention. Choosing the closest exemplar is mine; never ask which.
- **DFS API & environment discovery:** per-env endpoint/GraphQL trees for 74+ Additiv microservices at `~/Documents/projects/hera/.claude/skills/dfs-build-tree/assets/dfs-tree-<env>.{json,md}` — grep/jq them, never whole-read; keyword-triage script in `~/Documents/projects/hera/.claude/skills/dfs-lookup/scripts/`. Environment URL patterns, service mappings, `release.js` structure: `~/Documents/projects/hera/.claude/skills/environment-reference/SKILL.md`. Generic endpoint/auth/TLS triage procedure: `diagnose-api` (skill, invocable only in hera).
- **hera is read-only for us (except regenerating its component map), and holds more than the map and the DFS trees** — consume by path, never copy. Symptom index (template config/i18n/routing/theming defects, component API table, DFS API quirks, token minting, auth matrix, feature-block → service registry, DFS schema notes): `~/.claude/hydrogen-reference.md` §hera pointers — Read it on any of those symptoms before debugging.
- **Inventory before regex.** A question naming a domain → `ls` that domain dir (`ls widgets/wealth | grep -i <term>`) BEFORE any pattern search, and search by the shape of the seam (what the shared component *receives*), not the identifier you expect. A narrow null grep earns "didn't find", never "Hydrogen doesn't do this" — a negative claim about 288 packages needs enumeration. Same for STRUCTURE: before countering a proposed package split or layout, grep how the monorepo organises that shape.
- **Audit map by domain:** workflow/step/footer → `ui/workflow/`, `ui/layouts/step-layout/`, `widgets/wealth/{modify-investment,prospect-onboarding,custodian-onboarding}/`. Data hooks → `data/services/`, `data/gql/`, `data/wealth/`. Tables/lists/pagination → `ui/components/{table,pagination,modify-positions-table}/`. Routing → `core/router/`. Formatting/i18n/money-math → `core/i18n/`, `core.utils.base` (PreciseCalc + lodash-shaped helpers). IDs → uuid v4 (Hydrogen-wide convention).

## Reuse hierarchy — stop at the first fit
Hydrogen instantiation of global CLAUDE.md's dependency ladder — edits to either must keep them aligned.
1. Hydrogen hook/component/type as-is.
2. A Hydrogen primitive composed (e.g. a layout built from existing primitives).
3. In-place fork of one Hydrogen file with a minor edit (**not** a full package eject). The fork copies the file as written: every param, option, default, fallback and guard. The only edits are the ones the app forces, each named in the plan. `code-craft.md`'s right-size rule does not apply to a fork. A guard Hydrogen lacks is never added; when one is needed, reuse a check Hydrogen already uses, cited by file:line.
4. An OSS library — only if Hydrogen genuinely can't deliver it.
5. Custom from scratch — last resort, needs explicit justification against the above.

Prefer the Hydrogen wrapper over the raw lib even when that lib is a direct dep — the wrapper carries locale wiring and project conventions the raw call loses: `formatLocaleDate`/`convertToISOString`/`toUTCFormat` over `date-fns format`, `PreciseCalc` over raw arithmetic, `formatNumberCurrencyDisplay` or an i18n currency template (`t('{{val, currency(USD)}}', { val })`) over `Intl.NumberFormat`, `truncateDecimalNumber` over `toFixed`. **Exception:** pure date arithmetic with no locale/formatting concern (`addMonths`, `isBefore`) — direct date-fns is fine when no wrapper exists. Porting from a non-Hydrogen reference: translate each raw call (`Intl.*`, `toFixed`, `toISOString().slice()`) to its Hydrogen equivalent, never line-for-line.

## Source-vs-installed — the verification discipline
- The source monorepo is frequently **ahead** of an app's pinned version — a symbol in source may not be importable. Confirm it in the installed `dist/`; `tsc --noEmit` is the final arbiter.
- **Same name, different behaviour.** The app's copy may render or return differently (wrapper element, missing prop, other parser). Read it before porting monorepo code; when it returns `any`, run it once on a sampled value.
- `tsc` clean + `vite build` clean do **not** prove a lazily-loaded area renders — neither evaluates lazy chunks. A `/subpath` import into a package without an `exports` map type-checks yet can crash in Vite ("does not provide an export named 'default'"). Import from the main entry unless an `exports` map documents the subpath. **Browser-verify newly wired areas.**

## i18n — backend-driven, not local CSV
- Translations are fetched at runtime from a **backend resourceset API** (`/resourcesets/{name}/?language={lng}`) via `core.i18n`'s `InitLanguage` — the local CSV is only the source that must be synced/uploaded to that backend per environment.
- So new keys render as the raw key string (`common.skip-to-content`) in any environment whose backend resourceset isn't updated yet — **expected, not a frontend bug**. Verify the JSX composition is right and move on.

## On-demand reference — `~/.claude/hydrogen-reference.md`
Seven domain sections live there, plus §hera pointers (never injected — Read on symptom). `hooks/hydrogen-context.sh` injects the matching domain section once per session when a tool call touches its symbols; when reasoning about a domain without such a call, Read that section yourself before asserting anything.
- **Ejection** — eject vs in-place fork, two-commit flow, `@teambit` residue, nested-singleton `resolve.dedupe` trap.
- **Layouts & widget boundaries** — list/detail = separate widgets, `StepContent`/`ProcessContent`/`Content` pairing, no controlled accordion exists.
- **Workflows** — `ProtectRoutes` blocks Back and a router holds ONE blocker, per-workflow milestones, status `errors[]`/`isCancelable`, frozen `dataSource`, name bound at hook-init, process-state seams, custodian-onboarding exemplar. Engine-side contract (payload envelope, `/status` shape, `/schema`, cancel) is owned by hera — consume, never copy: `~/Documents/projects/hera/.claude/skills/workflow/references/payload-envelope-and-types.md`.
- **Data & caching** — hooks that ignore their props, `keepPreviousData` gating, `cacheTime:0` 404 latch trap.
- **Theming** — `getColor` on a token the theme lacks paints black, with no tsc or lint error.
- **Tables** — one `FieldsType[]` for columns and filter, raw rows, `customCells` may use hooks (desktop), filter seeding, `onSort` raw, page reset rules.
- **Forms** — `isSubmit`, stale `formRef`, `listKeyDataSource`, no form arrays in `HydrogenFormsContext`, `TextfieldWrap` prop leaks, `DecimalInput` clear→0 coercion.
