# Blueprint App Theme — Design

**Date:** 2026-07-21
**Goal:** Bring the kontexta.dev marketing site's "Blueprint × Ember" visual system into the kontexta web app (`apps/web`) as an **opt-in third theme** named `blueprint` — without changing the existing light/dark themes or making Blueprint the default.
**Depth (user-selected):** "Chrome + flourishes" — CSS token/chrome layer plus targeted component touches (~6-10 components). Not a full port: no grid paper or annotations inside content surfaces (editor, file tables, forms).

## Mechanism

### Theme registration
- `apps/web/src/components/theme/theme-provider.tsx`: add `themes={["light", "dark", "blueprint"]}` to the `NextThemesProvider` props. `attribute="class"`, `defaultTheme="dark"`, and `enableSystem` stay as-is. next-themes persists the choice in localStorage exactly like today.

### Tailwind dark-variant compatibility
- `apps/web/tailwind.config.*`: change `darkMode: "class"` to `darkMode: ["class", ":is(.dark, .blueprint)"]` so the 19 files using `dark:` utilities treat Blueprint as a dark theme with zero per-file changes.

### Token block (`apps/web/src/app/globals.css`)
Self-contained `.blueprint` block parallel to `.dark`:

```css
.blueprint {
  --bg-primary: #060A12;
  --bg-secondary: #0D1119;
  --bg-tertiary: #10141F;
  --text-primary: #E8EDF5;
  --text-secondary: #C4B49A;
  --muted: #A89880;
  --border: rgba(224, 144, 48, 0.3);

  --accent: #E09030;
  --accent-soft: rgba(224, 144, 48, 0.14);
  --success: #2F855A;
  --warning: #C0841A;
  --danger: #C05656;
}
```

### Square corners (one scoped rule)
```css
.blueprint [class*="rounded"] { border-radius: 0 !important; }
.blueprint .bp-keep-round { border-radius: 9999px !important; }
```
`.bp-keep-round` is the escape hatch, added during implementation to any element that reads wrong when squared (spinners, circular status dots, toggle knobs). The implementer sweeps the main screens and applies it where needed.

### Blueprint chrome utilities (globals.css, `.blueprint`-scoped)
```css
.blueprint .bp-annotation {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.blueprint .bp-dashed { border-style: dashed; }
.blueprint .bp-grid {
  background-image:
    linear-gradient(rgba(224,144,48,.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(224,144,48,.05) 1px, transparent 1px),
    linear-gradient(rgba(224,144,48,.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(224,144,48,.05) 1px, transparent 1px);
  background-size: 110px 110px, 110px 110px, 22px 22px, 22px 22px;
}
```
Outside `.blueprint`, `bp-annotation` / `bp-dashed` / `bp-grid` have **no rules** — components can carry these classes unconditionally and remain visually unchanged in light/dark.

### Fonts
- Load **Saira** as an additional next/font variable (e.g. `--font-saira`) in `apps/web/src/app/layout.tsx`.
- `.blueprint { --font-title: var(--font-saira); }` so headings match the marketing site under Blueprint only. Light/dark keep their current title face. (Cost: one extra font download; acceptable.)

## Flourishes (component touches)

1. **Theme toggle** (`src/components/layout/top-bar.tsx:242`): the binary toggle becomes a 3-way cycle light → dark → blueprint → light, with a distinct icon/tooltip for Blueprint (e.g. a drafting-square glyph). Must render correctly pre-hydration (existing `mounted` guard pattern).
2. **Top bar title block** (same file): right-hand side gains `<span className="bp-annotation">DWG NO. KX-66 · REV 4.0.0</span>` — rendered always, styled (visible) only under `.blueprint` via a companion rule (`display: none` outside `.blueprint`; `display: inline` inside). Version string comes from a single constant.
3. **Panel headers**: add `bp-annotation` to the header/title elements of: folder tree panel, file list header, Eyes/journal panel header, Hands panel header (exact elements identified during implementation from `src/components/folder-tree`, `file-list`, `eyes`, `hands`). No text changes — styling only.
4. **Panel containers / modal frames**: add `bp-dashed` to the main panel and modal borders touched in (3) plus the configure/publish modals if trivially reachable — dashed amber chrome under Blueprint, unchanged elsewhere.
5. **Login page + empty states**: add `bp-grid` to the login page background container and the main empty-state containers (no-project / no-file-selected states). Grid appears only under Blueprint.

## Out of scope

- Any change to light/dark token values or default theme.
- Grid paper or annotations inside the markdown editor, file tables, docs content, or calendar grid.
- Marketing-style FIG. tags on borders (deferred; requires per-panel positioning work).
- Mobile-specific redesign (theme applies as-is).

## Verification

- `pnpm build` (or the monorepo's build task for `apps/web`) passes.
- Manual pass cycling all three themes on: dashboard/home, docs page, calendar, login, configure modal. Checks: `dark:` utilities fire under Blueprint; no unreadable text (spot-check contrast of `--muted` on `--bg-primary`); corners squared; no layout shifts from the border-radius rule; theme survives reload; light/dark visually unchanged from before the branch.
- Grep guard: no `#E09030`/blueprint tokens leak outside the `.blueprint` scope in globals.css.
