---
name: react-best-practices
description: React performance rulebook (Vercel Engineering, 56 rules, Next.js-specific content pruned). Use when writing, reviewing, or refactoring React components — re-render patterns, async waterfalls, bundle size, effect hygiene. Perf only: an ask for "React best practices/standards" means the whole standard (rules of React/hooks, effects per react.dev "You Might Not Need an Effect", state design, keys, composition, a11y, loading/error states, typing), this rulebook being one part.
license: MIT
provenance: localized 2026-07-29 from vercel-labs/agent-skills @1.0.0; Next.js/RSC/api-route rules pruned (Vite SPA stack); refresh = re-clone + diff
metadata:
  author: vercel
  version: "1.0.0"
---

# Vercel React Best Practices

Comprehensive performance optimization guide for React applications, maintained by Vercel. Contains 56 rules across 7 categories, prioritized by impact to guide automated refactoring and code generation.

## When to Apply

Reference these guidelines when:
- Writing new React components or Next.js pages
- Implementing data fetching (client or server-side)
- Reviewing code for performance issues
- Refactoring existing React/Next.js code
- Optimizing bundle size or load times

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Eliminating Waterfalls | CRITICAL | `async-` |
| 2 | Bundle Size Optimization | CRITICAL | `bundle-` |
| 3 | Client-Side Data Fetching | MEDIUM-HIGH | `client-` |
| 4 | Re-render Optimization | MEDIUM | `rerender-` |
| 5 | Rendering Performance | MEDIUM | `rendering-` |
| 6 | JavaScript Performance | LOW-MEDIUM | `js-` |
| 7 | Advanced Patterns | LOW | `advanced-` |

## Quick Reference

### 1. Eliminating Waterfalls (CRITICAL)

- `async-cheap-condition-before-await` - Check Cheap Conditions Before Async Flags
- `async-defer-await` - Defer Await Until Needed
- `async-parallel` - Promise.all() for Independent Operations
- `async-dependencies` - Dependency-Based Parallelization

### 2. Bundle Size Optimization (CRITICAL)

- `bundle-barrel-imports` - Avoid Barrel File Imports
- `bundle-analyzable-paths` - Prefer Statically Analyzable Paths
- `bundle-dynamic-imports` - Dynamic Imports for Heavy Components
- `bundle-defer-third-party` - Defer Non-Critical Third-Party Libraries
- `bundle-conditional` - Conditional Module Loading
- `bundle-preload` - Preload Based on User Intent

### 3. Client-Side Data Fetching (MEDIUM-HIGH)

- `client-swr-dedup` - Use SWR for Automatic Deduplication
- `client-event-listeners` - Deduplicate Global Event Listeners
- `client-passive-event-listeners` - Use Passive Event Listeners for Scrolling Performance
- `client-localstorage-schema` - Version and Minimize localStorage Data

### 4. Re-render Optimization (MEDIUM)

- `rerender-defer-reads` - Defer State Reads to Usage Point
- `rerender-memo` - Extract to Memoized Components
- `rerender-memo-with-default-value` - Extract Default Non-primitive Parameter Value from Memoized Component to Constant
- `rerender-dependencies` - Narrow Effect Dependencies
- `rerender-derived-state` - Subscribe to Derived State
- `rerender-derived-state-no-effect` - Calculate Derived State During Rendering
- `rerender-functional-setstate` - Use Functional setState Updates
- `rerender-lazy-state-init` - Use Lazy State Initialization
- `rerender-simple-expression-in-memo` - Do not wrap a simple expression with a primitive result type in useMemo
- `rerender-split-combined-hooks` - Split Combined Hook Computations
- `rerender-move-effect-to-event` - Put Interaction Logic in Event Handlers
- `rerender-transitions` - Use Transitions for Non-Urgent Updates
- `rerender-use-deferred-value` - Use useDeferredValue for Expensive Derived Renders
- `rerender-use-ref-transient-values` - Use useRef for Transient Values
- `rerender-no-inline-components` - Don't Define Components Inside Components

### 5. Rendering Performance (MEDIUM)

- `rendering-animate-svg-wrapper` - Animate SVG Wrapper Instead of SVG Element
- `rendering-content-visibility` - CSS content-visibility for Long Lists
- `rendering-hoist-jsx` - Hoist Static JSX Elements
- `rendering-svg-precision` - Optimize SVG Precision
- `rendering-activity` - Use Activity Component for Show/Hide
- `rendering-conditional-render` - Use Explicit Conditional Rendering
- `rendering-usetransition-loading` - Use useTransition Over Manual Loading States
- `rendering-resource-hints` - Use React DOM Resource Hints
- `rendering-script-defer-async` - Use defer or async on Script Tags

### 6. JavaScript Performance (LOW-MEDIUM)

- `js-batch-dom-css` - Avoid Layout Thrashing
- `js-index-maps` - Build Index Maps for Repeated Lookups
- `js-cache-property-access` - Cache Property Access in Loops
- `js-cache-function-results` - Cache Repeated Function Calls
- `js-cache-storage` - Cache Storage API Calls
- `js-combine-iterations` - Combine Multiple Array Iterations
- `js-length-check-first` - Early Length Check for Array Comparisons
- `js-early-exit` - Early Return from Functions
- `js-hoist-regexp` - Hoist RegExp Creation
- `js-min-max-loop` - Use Loop for Min/Max Instead of Sort
- `js-set-map-lookups` - Use Set/Map for O(1) Lookups
- `js-tosorted-immutable` - Use toSorted() Instead of sort() for Immutability
- `js-flatmap-filter` - Use flatMap to Map and Filter in One Pass
- `js-request-idle-callback` - Defer Non-Critical Work with requestIdleCallback

### 7. Advanced Patterns (LOW)

- `advanced-effect-event-deps` - Do Not Put Effect Events in Dependency Arrays
- `advanced-event-handler-refs` - Store Event Handlers in Refs
- `advanced-init-once` - Initialize App Once, Not Per Mount
- `advanced-use-latest` - useEffectEvent for Stable Callback Refs

A rule that names a package (better-all, swr, lru-cache) applies only where the repo already installs it; otherwise use the installed mechanism or the platform.

## How to Use

Read individual rule files for detailed explanations and code examples:

```
rules/async-parallel.md
rules/bundle-barrel-imports.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references
