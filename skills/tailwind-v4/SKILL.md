---
name: tailwind-v4
description: Tailwind CSS v4 rules checked against the official v3-to-v4 upgrade guide; load when writing or reviewing Tailwind classes or CSS in a Tailwind v4 repo, or when migrating a repo from v3 to v4. It does not apply to Tailwind v3 repos.
license: MIT
provenance: localized 2026-10-22 from https://github.com/ofershap/tailwind-best-practices @61fe313 (plugin v0.1.0); verified against tailwindcss.com/docs/upgrade-guide (tailwindcss.com repo @aa6ad90) for tailwindcss@4.3.3; Patterns list pruned, gradient/config/opacity/rename/variant rules corrected, 6 upgrade-guide rules added (outline-hidden, ring-3, border colour, space-*, bg-(--var), trailing !); refresh = re-clone + diff
metadata:
  author: ofershap
  version: "0.1.0"
---

# Tailwind CSS v4

Models are trained mostly on v3 code, so they write v3 config, directives and class names. Each rule below matches the v4 upgrade guide or the v4 docs page for that feature.

## Setup and config

### 1. Use `@import` instead of `@tailwind` directives

**Wrong:** `@tailwind base; @tailwind components; @tailwind utilities;`

**Correct:**

```css
@import "tailwindcss";
```

**Why:** v4 imports Tailwind with a regular CSS `@import`, not the v3 `@tailwind` directives.

### 2. Configure the theme in CSS with `@theme`

**Wrong:**

```js
// tailwind.config.js
module.exports = { theme: { extend: { colors: { brand: "#3b82f6" }, spacing: { 18: "4.5rem" } } } };
```

**Correct:**

```css
@import "tailwindcss";

@theme {
  --color-brand: #3b82f6;
  --spacing-18: 4.5rem;
}
```

**Why:** Theme variables in `@theme` decide which utilities exist. A JS config is still supported for backward compatibility, but v4 no longer detects it automatically; load it explicitly with `@config "../tailwind.config.js";`. Its `corePlugins`, `safelist` and `separator` options are not supported.

### 3. Use the `@tailwindcss/postcss` plugin

**Wrong:** `plugins: { "postcss-import": {}, tailwindcss: {}, autoprefixer: {} }`

**Correct:**

```js
// postcss.config.mjs
export default { plugins: { "@tailwindcss/postcss": {} } };
```

**Why:** The PostCSS plugin moved to `@tailwindcss/postcss`, and v4 handles imports and vendor prefixing itself. With Vite, the guide recommends the `@tailwindcss/vite` plugin instead.

### 4. Use `@import "tailwindcss" important` for the global important flag

**Wrong:** `module.exports = { important: true };`

**Correct:**

```css
@import "tailwindcss" important;
```

**Why:** The `important` flag on the import marks every utility `!important`.

## Class names

### 5. Use opacity modifiers, not `*-opacity-*`

**Wrong:** `<div class="bg-red-500 bg-opacity-50 text-blue-600 text-opacity-75">`

**Correct:** `<div class="bg-red-500/50 text-blue-600/75">`

**Why:** `bg-opacity-*`, `text-opacity-*`, `border-opacity-*`, `divide-opacity-*`, `ring-opacity-*` and `placeholder-opacity-*` were removed. Use the slash modifier.

### 6. Use the renamed shadow, radius and blur scales

**Wrong (when you mean the smallest step):** `<div class="shadow-sm blur-sm rounded-sm">`

**Correct:** `<div class="shadow-xs blur-xs rounded-xs">`

**Why:** Every scale step now has a name: `shadow-sm` → `shadow-xs`, `shadow` → `shadow-sm`, and the same for `drop-shadow`, `blur`, `backdrop-blur` and `rounded`. The bare names still work for compatibility, but `*-sm` now renders what bare `*` rendered in v3.

### 7. Use `outline-hidden`, not `outline-none`

**Wrong:** `<input class="focus:outline-none" />`

**Correct:** `<input class="focus:outline-hidden" />`

**Why:** v3 `outline-none` set an invisible outline that still showed in forced colors mode. That utility is now `outline-hidden`, and the new `outline-none` really sets `outline-style: none`. `outline` now defaults to 1px, and `outline-<number>` sets `outline-style: solid` on its own.

### 8. Write `ring-3` and give rings a colour

**Wrong:** `<button class="focus:ring">`

**Correct:** `<button class="focus:ring-3 focus:ring-blue-500">`

**Why:** `ring` changed from 3px to 1px, and its default colour changed from `blue-500` to `currentColor`. Replace `ring` with `ring-3` and add `ring-blue-500` wherever you relied on the default colour.

### 9. Give borders and dividers an explicit colour where the v3 default was relied on

**Wrong:** `<div class="border px-2 py-3">` expecting a light grey line

**Correct:** `<div class="border border-gray-200 px-2 py-3">`, or the repo's own border token

**Why:** In v3, `border-*` and `divide-*` used `gray-200` by default. In v4 they use `currentColor`. A repo that sets its border colour in `@theme` or a base layer needs no change; one that relied on the v3 default does.

### 10. Use `bg-linear-*` for gradients

**Wrong:** `<div class="bg-gradient-to-r from-blue-500 to-purple-500">`

**Correct:** `<div class="bg-linear-to-r from-blue-500 to-purple-500">`

**Why:** The v4 docs name linear gradients `bg-linear-to-*` and `bg-linear-<angle>` (for example `bg-linear-45`), alongside `bg-radial` and `bg-conic-<angle>`. `bg-gradient-to-*` still compiles in 4.3.3, but only as a legacy alias.

### 11. Use `bg-(--var)` for CSS variables in arbitrary values

**Wrong:** `<div class="bg-[--brand-color]">`

**Correct:** `<div class="bg-(--brand-color)">`

**Why:** Bare variables in square brackets are ambiguous in modern CSS, so v4 uses parentheses. `bg-(--x)` is shorthand for `bg-[var(--x)]`.

### 12. Put the important modifier at the end

**Wrong:** `<div class="!flex !bg-red-500 hover:!bg-red-600/50">`

**Correct:** `<div class="flex! bg-red-500! hover:bg-red-600/50!">`

**Why:** v4 puts `!` at the very end of the class name. The leading `!` still works but is deprecated.

### 13. Prefer theme variables over one-off arbitrary colours

**Wrong:** `<div class="bg-[#3b82f6]">`

**Correct:** `@theme { --color-brand: #3b82f6; }`, then `<div class="bg-brand">`

**Why:** This is style guidance, not a v4 change. The docs say a design is usually built from a constrained set of tokens, and arbitrary values are for the rare one-off.

## Layout and variants

### 14. Know the new `space-x-*` / `space-y-*` selector

**Before (v3):** `.space-y-4 > :not([hidden]) ~ :not([hidden]) { margin-top: 1rem; }`

**Now (v4):** `.space-y-4 > :not(:last-child) { margin-bottom: 1rem; }`

**Why:** The selector changed for performance. Layouts that use `space-*` with inline children, or that add their own margins to children, can shift. The guide recommends a flex or grid layout with `gap` instead: `class="flex flex-col gap-4"`. `divide-x-*` / `divide-y-*` changed the same way.

### 15. Use container queries for parent-sized layouts

**Viewport-based:** `<div class="flex flex-col md:flex-row">`

**Correct (when the layout should follow its parent, not the viewport):**

```html
<div class="@container">
  <div class="flex flex-col @md:flex-row"></div>
</div>
```

**Why:** Container queries are built in. Mark the parent with `@container` and use `@sm:`, `@md:` or `@max-md:` on children.

### 16. Use `@utility` for custom utilities

**Wrong:** `@layer utilities { .content-auto { content-visibility: auto; } }`

**Correct:**

```css
@utility content-auto {
  content-visibility: auto;
}
```

**Why:** v4 uses native cascade layers and no longer hijacks `@layer`, so `@utility` replaces `@layer utilities` and makes the class work with variants. `@layer components` is still documented for component classes such as `.card` that utilities should override. Define custom variants with `@custom-variant`; `@variant` only applies an existing variant inside CSS.

### 17. Use the `not-*` variant for negation

**Wrong:** `<button class="hover:bg-indigo-700">` with no way to skip the hover style while the button is focused.

**Correct:** `<button class="bg-indigo-600 hover:not-focus:bg-indigo-700">`

**Why:** `not-*` styles an element when a condition is not true, and it combines with other variants.

### 18. Use `starting:` for entry transitions

**Wrong:** toggling an `.open` class from JavaScript to animate in.

**Correct:** `<div class="starting:opacity-0 opacity-100 transition-opacity duration-300">`; for an element that leaves `display: none` (a popover or dialog), add `transition-discrete` as the docs example does.

**Why:** The `starting` variant maps to `@starting-style` and sets how an element looks when it is first rendered or leaves `display: none`, with no JavaScript.

## Anti-patterns

- Do not add `tailwind.config.js` for theme tokens; use `@theme`, and load a JS config only through `@config`.
- Do not keep `postcss-import` or `autoprefixer` in a v4 PostCSS setup.
- Do not write bare `ring`, bare `border` without a colour, or `outline-none` when you mean the v3 behaviour.
- Do not use `*-opacity-*` utilities or `[--var]` arbitrary values.
