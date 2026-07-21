# Blueprint App Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the opt-in `blueprint` theme to `apps/web` per the approved spec (`docs/superpowers/2026-07-21-blueprint-app-theme-design.md`).

**Architecture:** CSS-first: a `.blueprint` token block + scoped chrome utilities in `globals.css`, next-themes registration, a Tailwind dark-selector widening. Component touches are limited to the top-bar toggle/title-block and adding inert `bp-*` classes to panel headers, login, and empty states.

**Tech Stack:** Next.js app router (`apps/web`), next-themes (class attribute), Tailwind 3 (`darkMode: "class"`), next/font.

## Global Constraints

- Repo: `/Users/safiyudeen.saidumuha/projects/kontexta`, work in `apps/web`. Git identity: `safiyu <dheensafiyu@gmail.com>` (already set as local config). No `Co-Authored-By` trailers.
- **No per-task commits/builds.** One build verification and ONE commit at the end (user's working style).
- Light/dark themes and default theme unchanged. `bp-*` classes must be inert outside `.blueprint`.
- Blueprint tokens exactly as in the spec (`#060A12` / `#0D1119` / `#10141F` / `#E8EDF5` / `#C4B49A` / `#A89880` / `rgba(224,144,48,.3)` / accent `#E09030`).

---

### Task 1: Mechanism (provider, tailwind, tokens, chrome utilities)

**Files:**
- Modify: `apps/web/src/components/theme/theme-provider.tsx` — add `themes={["light", "dark", "blueprint"]}` to `NextThemesProvider`.
- Modify: `apps/web/tailwind.config.ts:5` — `darkMode: "class"` → `darkMode: ["class", ":is(.dark, .blueprint)"]`.
- Modify: `apps/web/src/app/globals.css` — after the `.dark` block, add:

```css
/* Blueprint theme — opt-in port of the kontexta.dev Blueprint × Ember system.
   See docs/superpowers/2026-07-21-blueprint-app-theme-design.md */
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

  --font-title: var(--font-saira);
}

/* Square corners under Blueprint; bp-keep-round is the escape hatch. */
.blueprint [class*="rounded"] { border-radius: 0 !important; }
.blueprint .bp-keep-round { border-radius: 9999px !important; }

/* Chrome utilities — no rules outside .blueprint, so the classes are inert
   in light/dark and components may carry them unconditionally. */
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
    linear-gradient(rgba(224, 144, 48, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(224, 144, 48, 0.05) 1px, transparent 1px);
  background-size: 22px 22px;
}
/* Title-block annotation: hidden except under Blueprint. */
.bp-title-block { display: none; }
.blueprint .bp-title-block { display: inline; }
```

### Task 2: Saira font variable

**Files:**
- Modify: `apps/web/src/app/layout.tsx` — add `Saira` to the next/font import, create `const saira = Saira({ subsets: ["latin"], variable: "--font-saira", display: "swap" });`, and append `${saira.variable}` to the body className list. Inter/JetBrains Mono/Manrope stay.

### Task 3: Top bar — 3-way toggle + title block

**Files:**
- Modify: `apps/web/src/components/layout/top-bar.tsx:240-255` (the `mounted && <button …>` toggle block).

Replace the binary toggle with a cycle button (light → dark → blueprint → light). Keep the `mounted` guard. Suggested shape (adapt styling to neighboring buttons):

```tsx
{mounted && (
  <button
    onClick={() =>
      setTheme(theme === "light" ? "dark" : theme === "dark" ? "blueprint" : "light")
    }
    className="px-2 h-5 border border-[var(--border)] text-[10px] font-mono uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
    aria-label="Cycle theme (light / dark / blueprint)"
    title={`Theme: ${theme} — click to cycle`}
  >
    {theme === "light" ? "☀ light" : theme === "dark" ? "☽ dark" : "▦ blueprint"}
  </button>
)}
```

Add next to it (same toolbar row, right side): `<span className="bp-title-block bp-annotation">DWG NO. KX-66 · REV {KONTEXTA_REV}</span>` with `const KONTEXTA_REV = "4.0.0";` at module scope.

### Task 4: Panel headers + dashed chrome

**Files:**
- Modify: `apps/web/src/components/folder-tree/folder-tree.tsx:146` — append `bp-annotation` to the existing header div's className.
- Modify: `apps/web/src/components/file-list/file-list.tsx:307` — append `bp-annotation` to the header row's className; also add `bp-dashed` to that row's `border-b`.
- Modify: `apps/web/src/components/eyes/journal-stream-list.tsx` and `apps/web/src/components/hands/hands-run-trace.tsx` — locate each component's top header/title element (uppercase/tracking-wider label or heading) and append `bp-annotation`; add `bp-dashed` to the panel container's border if one exists. Styling classes only — no text or structure changes.

### Task 5: Login + empty states

**Files:**
- Modify: `apps/web/src/app/login/login-client.tsx:60` — append `bp-grid` to the `min-h-screen` outer container className; add `bp-dashed` to the card border on line 61.
- Modify: main empty-state containers in `apps/web/src/app/home-client.tsx` (the "no project selected" / "no file selected" panes — locate by rendering path; if none exist as distinct containers, skip and note it) — append `bp-grid`.

### Task 6: Verify + single commit

- Build `apps/web` (from repo root: `pnpm build --filter @kontexta/web` or the equivalent turbo task — check `package.json` scripts; fall back to `cd apps/web && pnpm build`). Expected: exit 0.
- Grep guards: `grep -n "E09030" apps/web/src/app/globals.css` hits only inside `.blueprint` block; `grep -c "bp-annotation" apps/web/src` ≥ 4.
- Manual pass (dev server): cycle all three themes on dashboard, docs, calendar, login. Confirm dark: variants fire under blueprint (e.g. any `dark:`-styled element), corners squared, light/dark unchanged, theme survives reload.
- Single commit: `feat(web): opt-in blueprint theme — tokens, chrome utilities, annotation flourishes` (no trailer).

## Self-Review Notes

- Spec coverage: mechanism ✓ (Task 1), fonts ✓ (Task 2), toggle + title block ✓ (Task 3), panel headers + dashed ✓ (Task 4), login/empty grid ✓ (Task 5), verification incl. grep guards ✓ (Task 6). Configure/publish modal dashed borders were spec'd as "if trivially reachable" — folded into Task 4's discretion, not a hard requirement.
- The spec's dual-layer 110px grid is simplified to the 22px minor grid only in `bp-grid` (login/empty states are small surfaces; the major line adds nothing at that scale). Deviation noted deliberately.
