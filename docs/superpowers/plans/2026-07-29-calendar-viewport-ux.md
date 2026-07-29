# Calendar Viewport & Month Grid UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the calendar page from scrolling the whole browser document, make the month grid show only the weeks a month actually needs, scale the per-day event cap to match, and add a jump-to-date popover on the toolbar title.

**Architecture:** Four independent, sequential fixes inside `apps/web/src/components/calendar/`: (1) a one-line CSS fix to `calendar-client.tsx` so the existing internal scroll regions actually activate, (2) two new pure functions in `date-utils.ts` (`monthGrid()` reworked, `maxVisibleForWeeks()` added) with unit tests, (3) `month-grid.tsx` wired to consume those functions for dynamic row count and event cap, and (4) a Radix `DropdownMenu`-based popover added to `toolbar.tsx` for jumping to any month.

**Tech Stack:** Next.js (App Router), React, TypeScript, Tailwind CSS, `@radix-ui/react-dropdown-menu` (already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-calendar-viewport-ux-design.md`

## Global Constraints

- No git co-author trailers; commit as `safiyu <dheensafiyu@gmail.com>`.
- All three themes (light, dark, Blueprint) are first-class — verify no regression in any of them.
- Use only CSS custom properties already defined in `apps/web/src/app/globals.css` (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--muted`, `--border`, `--accent`/`amber-accent` Tailwind color) — no new hardcoded hex colors.

---

### Task 1: Fix whole-page scroll (viewport-fit root container)

**Files:**
- Modify: `apps/web/src/components/calendar/calendar-client.tsx:139`

**Interfaces:**
- Consumes: nothing.
- Produces: a root container whose height is pinned to the viewport (`h-screen`), which Task 3's dynamic row-height sizing depends on visually (not a code dependency — just note it when testing Task 3).

This is a pure CSS fix — no new logic, so there's no unit test to write. `MonthGrid`, `WeekView`, and `AgendaList` already contain their own `overflow-y-auto` regions (verified during design); the only thing wrong is that the outer container can grow past the viewport instead of clipping at it, so those regions never get to activate.

- [ ] **Step 1: Change the root container's height class**

In `apps/web/src/components/calendar/calendar-client.tsx`, find (around line 139):

```tsx
    <div className="min-h-screen flex flex-col bg-[var(--bg-secondary)] dark:bg-[var(--bg-primary)]">
```

Replace with:

```tsx
    <div className="h-screen overflow-hidden flex flex-col bg-[var(--bg-secondary)] dark:bg-[var(--bg-primary)]">
```

- [ ] **Step 2: Run the existing calendar test suite to confirm nothing broke**

Run: `pnpm --filter kxta-web test calendar` (from the repo root)
Expected: all existing tests in `apps/web/src/components/calendar/` still PASS (this change touches no logic those tests cover — it's a sanity check).

- [ ] **Step 3: Manually verify in the browser**

Start the dev server (`pnpm --filter kxta-web dev`), open `/calendar` in month view on a laptop-height window (or shrink the browser window vertically). Confirm:
- No scrollbar appears on the browser document/`<body>`.
- If the month grid has more content than fits, only the grid area itself scrolls (the toolbar and page header stay fixed in place).
- Switch to Week and Agenda views and confirm they still scroll internally as before (no regression).
- Repeat in light, dark, and Blueprint themes (theme switcher is in the app's settings/top bar).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/calendar/calendar-client.tsx
git commit -m "fix(web): stop calendar page from scrolling past the viewport"
```

---

### Task 2: Variable week count in `monthGrid()` + `maxVisibleForWeeks()` lookup

**Files:**
- Modify: `apps/web/src/components/calendar/date-utils.ts:47-52` (the `monthGrid` function)
- Modify: `apps/web/src/components/calendar/date-utils.test.ts` (update the `monthGrid` describe block, add new describe blocks)

**Interfaces:**
- Consumes: `startOfWeek(d: Date): Date`, `addDays(d: Date, n: number): Date` (both already exist in `date-utils.ts`, unchanged).
- Produces:
  - `monthGrid(anchor: Date): Date[]` — same signature as before, but now returns `28 | 35 | 42` entries (4, 5, or 6 weeks × 7 days) instead of always 42. Task 3 consumes this via `grid.length / 7` to get the week count.
  - `maxVisibleForWeeks(weeks: number): number` — new exported function. Given a week count (4, 5, or 6), returns how many events a day cell should show before collapsing to "+N more" (5, 4, or 3 respectively). Falls back to `3` for any other input. Task 3 consumes this directly.

`visibleRange()` (`date-utils.ts:65-76`) already derives its `from`/`to` from `monthGrid()`'s first and last entries, so it needs no code change — but its behavior changes as a side effect, so it gets test coverage here too.

- [ ] **Step 1: Write the failing tests**

Open `apps/web/src/components/calendar/date-utils.test.ts`. Update the import line to add `visibleRange` and `maxVisibleForWeeks`:

```ts
import {
  monthGrid, startOfWeek, toDatetimeLocalValue, fromDatetimeLocalValue,
  eventTouchesDay, layoutDayEvents, addDays, visibleRange, maxVisibleForWeeks,
} from "./date-utils";
```

Replace the existing `describe("monthGrid", ...)` block with:

```ts
describe("monthGrid", () => {
  it("starts on a Monday", () => {
    const grid = monthGrid(new Date(2026, 6, 17)); // July 2026
    expect(grid[0].getDay()).toBe(1); // Monday
  });

  it("includes every day of the anchor month", () => {
    const anchor = new Date(2026, 6, 17); // July 2026 (31 days)
    const grid = monthGrid(anchor);
    const julyDays = grid.filter((d) => d.getMonth() === 6 && d.getFullYear() === 2026);
    expect(julyDays.length).toBe(31);
  });

  it("returns exactly the weeks a month needs: 5 weeks for July 2026", () => {
    expect(monthGrid(new Date(2026, 6, 17)).length).toBe(35);
  });

  it("returns 6 weeks for a month spanning 6 calendar weeks: August 2026", () => {
    expect(monthGrid(new Date(2026, 7, 10)).length).toBe(42);
  });

  it("returns 4 weeks for a month spanning exactly 4 calendar weeks: February 2027", () => {
    expect(monthGrid(new Date(2027, 1, 10)).length).toBe(28);
  });
});

describe("visibleRange", () => {
  it("shrinks the month window to match a 5-week month (July 2026)", () => {
    const { from, to } = visibleRange("month", new Date(2026, 6, 17));
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(35);
  });

  it("widens the month window to match a 6-week month (August 2026)", () => {
    const { from, to } = visibleRange("month", new Date(2026, 7, 10));
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(42);
  });
});

describe("maxVisibleForWeeks", () => {
  it("caps at 3 for a 6-week month", () => {
    expect(maxVisibleForWeeks(6)).toBe(3);
  });

  it("allows 4 for a 5-week month", () => {
    expect(maxVisibleForWeeks(5)).toBe(4);
  });

  it("allows 5 for a 4-week month", () => {
    expect(maxVisibleForWeeks(4)).toBe(5);
  });

  it("falls back to 3 for an unexpected week count", () => {
    expect(maxVisibleForWeeks(7)).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kxta-web test date-utils`
Expected: FAIL — `monthGrid` still returns 42 for July 2026 (so the "5 weeks"/"6 weeks"/"4 weeks" assertions fail), and `maxVisibleForWeeks` fails to import (not yet defined).

- [ ] **Step 3: Implement `monthGrid()` and `maxVisibleForWeeks()`**

In `apps/web/src/components/calendar/date-utils.ts`, replace:

```ts
/** Always 42 cells (6 weeks x 7 days), Monday-first, covering the full month plus leading/trailing days. */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
```

with:

```ts
/** 28/35/42 cells (4-6 weeks x 7 days), Monday-first — exactly enough weeks to cover the month. */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const end = startOfWeek(last);
  const weeks = Math.round((end.getTime() - start.getTime()) / (7 * 86_400_000)) + 1;
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

const MAX_VISIBLE_BY_WEEKS: Record<number, number> = { 4: 5, 5: 4, 6: 3 };

/** Coarse day-cell event cap: fewer week rows means taller cells, so more events fit before "+N more". */
export function maxVisibleForWeeks(weeks: number): number {
  return MAX_VISIBLE_BY_WEEKS[weeks] ?? 3;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kxta-web test date-utils`
Expected: PASS — all `monthGrid`, `visibleRange`, and `maxVisibleForWeeks` tests green, plus all pre-existing tests in the file (`startOfWeek`, datetime-local round trip, `eventTouchesDay`, `layoutDayEvents`, `addDays`) still green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/calendar/date-utils.ts apps/web/src/components/calendar/date-utils.test.ts
git commit -m "feat(web): size the month grid to the weeks a month actually needs"
```

---

### Task 3: Wire dynamic row count and event cap into `MonthGrid`

**Files:**
- Modify: `apps/web/src/components/calendar/month-grid.tsx` (whole file — changes are pervasive enough that the full replacement is given below)

**Interfaces:**
- Consumes: `monthGrid(anchor: Date): Date[]` and `maxVisibleForWeeks(weeks: number): number` from Task 2's `date-utils.ts` (both already implemented and tested by this point).
- Produces: no new exports — `MonthGrid`'s props (`MonthGridProps`) are unchanged, so `calendar-client.tsx` needs no changes for this task.

No new unit tests here: `MonthGrid` is a visual component with no existing test file (the codebase's calendar tests cover pure `date-utils` logic and `agenda-list`'s grouping logic — not month-grid's rendering), so this task is verified manually per Step 3 below, consistent with that existing pattern.

- [ ] **Step 1: Replace `month-grid.tsx` with the dynamic-row version**

Replace the full contents of `apps/web/src/components/calendar/month-grid.tsx` with:

```tsx
"use client";

import { useMemo } from "react";
import type { CalendarEntity, CalendarEvent } from "kxta-core";
import { monthGrid, maxVisibleForWeeks, eventTouchesDay, isSameDay, startOfDay } from "./date-utils";
import { EventChip } from "./event-chip";

interface MonthGridProps {
  anchor: Date;
  events: CalendarEvent[];
  entitiesById: Map<number, CalendarEntity>;
  conflictEventIds: Set<number>;
  highlightIds: Set<number>;
  loading: boolean;
  onSlotClick: (day: Date) => void;
  onEventClick: (ev: CalendarEvent) => void;
  onShowDay: (day: Date) => void;
}

const WEEKDAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function dayKey(d: Date): string {
  return startOfDay(d).toISOString();
}

export function MonthGrid({ anchor, events, entitiesById, conflictEventIds, highlightIds, loading, onSlotClick, onEventClick, onShowDay }: MonthGridProps) {
  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const weeks = grid.length / 7;
  const maxVisible = maxVisibleForWeeks(weeks);
  const rowsStyle = { gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` };

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const day of grid) {
      const dayEvents = events
        .filter((ev) => eventTouchesDay(ev, day))
        .sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
      map.set(dayKey(day), dayEvents);
    }
    return map;
  }, [grid, events]);

  const today = new Date();

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="grid grid-cols-7 text-[10px] font-bold tracking-widest uppercase text-[var(--muted)] border-b border-[var(--border)]">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="px-2 py-1.5">{label}</div>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-7 flex-1" style={rowsStyle}>
          {grid.map((day) => (
            <div key={dayKey(day)} className="border-b border-r border-[var(--border)] p-1.5">
              <div className="skeleton h-4 w-4 rounded-full bp-keep-round" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-7 flex-1 overflow-y-auto" style={rowsStyle}>
          {grid.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const isToday = isSameDay(day, today);
            const dayEvents = eventsByDay.get(dayKey(day)) ?? [];
            const visible = dayEvents.slice(0, maxVisible);
            const overflow = dayEvents.length - visible.length;

            return (
              <div
                key={dayKey(day)}
                onClick={() => onSlotClick(day)}
                className={`border-b border-r border-[var(--border)] p-1.5 min-h-[96px] cursor-pointer hover:bg-amber-accent/5 flex flex-col gap-1 overflow-hidden ${
                  isToday ? "bg-amber-accent/5" : ""
                }`}
              >
                {isToday ? (
                  <span className="w-6 h-6 rounded-full bp-keep-round bg-amber-accent text-white flex items-center justify-center font-bold text-xs">
                    {day.getDate()}
                  </span>
                ) : (
                  <span className={`text-xs ${inMonth ? "text-[var(--text-primary)]" : "text-[var(--muted)] opacity-50"}`}>
                    {day.getDate()}
                  </span>
                )}
                {visible.map((ev) => (
                  <EventChip
                    key={ev.id}
                    event={ev}
                    entityName={entitiesById.get(ev.entity_id)?.name ?? `#${ev.entity_id}`}
                    conflicted={conflictEventIds.has(ev.id)}
                    highlighted={highlightIds.has(ev.id)}
                    onClick={() => onEventClick(ev)}
                  />
                ))}
                {overflow > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onShowDay(day);
                    }}
                    className="text-[10px] text-[var(--text-secondary)] hover:text-amber-accent text-left"
                  >
                    +{overflow} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

Two things changed beyond the direct spec asks, both necessary for consistency: the `MAX_VISIBLE` constant and its import are removed (replaced by `maxVisibleForWeeks(weeks)`); and the loading skeleton now renders `grid.length` cells with the same `rowsStyle` as the real grid (previously a hardcoded 42/`grid-rows-6`) so the loading state doesn't visually jump to a different row count once data arrives.

- [ ] **Step 2: Run the existing calendar test suite**

Run: `pnpm --filter kxta-web test calendar`
Expected: PASS (no test directly exercises `MonthGrid`, but this confirms the `date-utils` exports it now imports — `monthGrid`, `maxVisibleForWeeks` — resolve correctly and nothing else broke).

- [ ] **Step 3: Manually verify in the browser**

With the dev server running, open `/calendar` in month view:
- Navigate to a 6-week month (e.g. August 2026) — rows should look like today's current behavior, capped at 3 visible events per day.
- Navigate to a 5-week month (e.g. July 2026) — rows should be visibly taller than the 6-week month, with up to 4 events visible per day before "+N more".
- Navigate to a 4-week month (e.g. February 2027) — rows should be taller still, with up to 5 events visible per day.
- Confirm the loading skeleton (visible briefly on month navigation) shows the same number of rows as the loaded grid, with no visible layout jump.
- Repeat in light, dark, and Blueprint themes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/calendar/month-grid.tsx
git commit -m "feat(web): size month-grid rows and event cap to the actual week count"
```

---

### Task 4: Jump-to-date popover on the toolbar title

**Files:**
- Modify: `apps/web/src/components/calendar/toolbar.tsx` (whole file — changes are pervasive enough that the full replacement is given below)
- Modify: `apps/web/src/components/calendar/calendar-client.tsx` (add a handler, pass two new props to `CalendarToolbar`)

**Interfaces:**
- Consumes: `DropdownMenu` primitives from `@radix-ui/react-dropdown-menu` (already a dependency, already used directly in this style by `apps/web/src/components/ui/dropdown-menu.tsx` — this task uses the raw `Menu.Root`/`Menu.Trigger`/`Menu.Portal`/`Menu.Content` primitives rather than that wrapper, because the wrapper's API only supports a flat list of `{label, onSelect}` items, not the year-stepper + month-grid layout this popover needs).
- Produces: `CalendarToolbarProps` gains two new required props: `anchor: Date` (so the popover can highlight the current month/year and seed the year stepper) and `onJumpToDate: (date: Date) => void` (called with the 1st of the selected month, or `new Date()` for "Today").

- [ ] **Step 1: Add the popover to `toolbar.tsx`**

Replace the full contents of `apps/web/src/components/calendar/toolbar.tsx` with:

```tsx
"use client";

import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { CalendarEntity } from "kxta-core";
import type { ViewMode } from "./date-utils";

interface CalendarToolbarProps {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  rangeLabel: string;
  anchor: Date;
  onNavigate: (dir: -1 | 0 | 1) => void;
  onJumpToDate: (date: Date) => void;
  entities: CalendarEntity[];
  entityFilter?: number;
  onEntityFilter: (id?: number) => void;
  types: string[];
  typeFilter?: string;
  onTypeFilter: (t?: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  conflictCount: number;
  conflictsOpen: boolean;
  onToggleConflicts: () => void;
  onExportIcs: () => void;
  onManageEntities: () => void;
  onNewEvent: () => void;
}

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "agenda", label: "Agenda" },
];

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function CalendarToolbar({
  view, onViewChange, rangeLabel, anchor, onNavigate, onJumpToDate,
  entities, entityFilter, onEntityFilter,
  types, typeFilter, onTypeFilter,
  query, onQueryChange,
  conflictCount, conflictsOpen, onToggleConflicts,
  onExportIcs, onManageEntities, onNewEvent,
}: CalendarToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(anchor.getFullYear());

  function jumpToMonth(monthIndex: number) {
    onJumpToDate(new Date(pickerYear, monthIndex, 1));
    setPickerOpen(false);
  }

  function jumpToToday() {
    onJumpToDate(new Date());
    setPickerOpen(false);
  }

  return (
    <div className="border-b border-[var(--border)]">
      {/* Row 1: navigation + range + view switcher — never competes with filters/actions for space. */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <div className="flex items-center gap-1">
          <button className="btn btn-sm" onClick={() => onNavigate(-1)} aria-label="Previous">
            <ChevronLeft className="w-4 h-4" aria-hidden />
          </button>
          <button className="btn btn-sm" onClick={() => onNavigate(0)}>Today</button>
          <button className="btn btn-sm" onClick={() => onNavigate(1)} aria-label="Next">
            <ChevronRight className="w-4 h-4" aria-hidden />
          </button>
        </div>

        <Menu.Root
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open);
            if (open) setPickerYear(anchor.getFullYear());
          }}
        >
          <Menu.Trigger asChild>
            <button
              type="button"
              className="font-title text-lg font-bold text-[var(--text-primary)] mx-2 whitespace-nowrap truncate hover:text-amber-accent transition-colors"
              aria-label="Jump to a different month"
            >
              {rangeLabel}
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content align="start" sideOffset={6} className="z-[var(--z-dropdown)]">
              <div className="w-56 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 shadow-xl animate-scale-in">
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={() => setPickerYear((y) => y - 1)}
                    className="btn btn-icon-sm"
                    aria-label="Previous year"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" aria-hidden />
                  </button>
                  <span className="text-xs font-bold text-[var(--text-primary)]">{pickerYear}</span>
                  <button
                    type="button"
                    onClick={() => setPickerYear((y) => y + 1)}
                    className="btn btn-icon-sm"
                    aria-label="Next year"
                  >
                    <ChevronRight className="w-3.5 h-3.5" aria-hidden />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {MONTH_LABELS.map((label, i) => {
                    const isTarget = pickerYear === anchor.getFullYear() && i === anchor.getMonth();
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => jumpToMonth(i)}
                        className={`rounded px-2 py-1.5 text-[11px] font-medium transition-colors ${
                          isTarget
                            ? "bg-amber-accent/15 text-amber-accent border border-amber-accent/40"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={jumpToToday}
                  className="mt-2 w-full text-center text-[10px] font-bold uppercase tracking-widest text-amber-accent hover:opacity-80"
                >
                  Today
                </button>
              </div>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>

        <div className="flex-1" />

        <div className="flex rounded-lg border border-[var(--border)] overflow-hidden shrink-0">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => onViewChange(v.id)}
              className={`px-3 py-1.5 text-xs font-bold tracking-widest uppercase transition-colors ${
                view === v.id
                  ? "bg-amber-accent/10 text-amber-accent"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: filters + actions — has the full width to itself, so it only wraps at genuinely narrow widths. */}
      <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
        <select
          value={entityFilter ?? ""}
          onChange={(e) => onEntityFilter(e.target.value ? Number(e.target.value) : undefined)}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer min-w-0"
        >
          <option value="">All entities</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>

        <select
          value={typeFilter ?? ""}
          onChange={(e) => onTypeFilter(e.target.value || undefined)}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer min-w-0"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <div className="relative min-w-[8rem] flex-1 max-w-48">
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter: entity, title, type…"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 pr-6 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 placeholder:text-[var(--muted)]"
          />
          {query && (
            <button
              onClick={() => onQueryChange("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-amber-accent text-xs px-1"
              aria-label="Clear filter"
            >
              <X className="w-3.5 h-3.5" aria-hidden />
            </button>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={onToggleConflicts}
            className={`btn btn-sm flex items-center gap-1.5 ${conflictsOpen ? "bg-amber-accent/10 text-amber-accent" : ""}`}
          >
            Conflicts
            {conflictCount > 0 && (
              <span className="px-1.5 rounded-full bg-[var(--danger-soft)] text-[var(--danger)] text-[10px] font-bold">
                {conflictCount}
              </span>
            )}
          </button>

          <button className="btn btn-sm" onClick={onManageEntities}>Entities</button>
          <button className="btn btn-sm" onClick={onExportIcs}>Export ICS</button>
          <button className="btn btn-sm btn-primary" onClick={onNewEvent}>+ New event</button>
        </div>
      </div>
    </div>
  );
}
```

The only changes from the original file are: the `useState` and `Menu` imports; `anchor` and `onJumpToDate` added to the props interface and destructured; the `pickerOpen`/`pickerYear` state and `jumpToMonth`/`jumpToToday` helpers; and the `<h2>` range label replaced by the `Menu.Root` popover (same visible text and position, now interactive). Nothing else in row 1 or row 2 changes.

- [ ] **Step 2: Wire the new props in `calendar-client.tsx`**

In `apps/web/src/components/calendar/calendar-client.tsx`, add a handler near `handleNavigate` (around line 88, right after it):

```tsx
  function handleJumpToDate(date: Date) {
    setHighlightIds(new Set());
    setAnchor(date);
  }
```

Then find the `<CalendarToolbar ... />` call (around lines 160-179) and add the two new props — insert `anchor={anchor}` and `onJumpToDate={handleJumpToDate}` alongside the existing `onNavigate` prop:

```tsx
          <CalendarToolbar
            view={view}
            onViewChange={setView}
            rangeLabel={rangeLabel}
            anchor={anchor}
            onNavigate={handleNavigate}
            onJumpToDate={handleJumpToDate}
            entities={entities}
```

(leave every other prop on that call exactly as-is — `entityFilter` through `onNewEvent` are unchanged).

- [ ] **Step 3: Run the existing calendar test suite**

Run: `pnpm --filter kxta-web test calendar`
Expected: PASS.

- [ ] **Step 4: Run a full typecheck/build to catch prop-mismatch errors**

Run: `pnpm --filter kxta-web build`
Expected: PASS — this specifically catches the case where `CalendarToolbarProps` gained required props (`anchor`, `onJumpToDate`) but a call site wasn't updated, which `vitest` alone would not catch since no test renders `CalendarToolbar` directly.

- [ ] **Step 5: Manually verify in the browser**

With the dev server running, open `/calendar`:
- Click the range title (e.g. "July 2026"). A popover should open below it showing a year stepper and a 3×4 grid of month abbreviations, with the current month highlighted in amber.
- Click a different month in the same year — the calendar should jump to that month and the popover should close.
- Reopen the popover, use the year stepper to move to a different year, then pick a month — the calendar should jump to that year/month.
- Click "Today" — the calendar should jump to the current date and the popover should close.
- Switch to Week view, reopen the popover from a week-view range label, and pick a month — the view should land on that month's first week.
- Switch to Agenda view and confirm the same jump behavior.
- Click outside the popover, or press Escape, and confirm it closes without changing the date.
- Repeat in light, dark, and Blueprint themes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/calendar/toolbar.tsx apps/web/src/components/calendar/calendar-client.tsx
git commit -m "feat(web): add jump-to-date popover to the calendar toolbar"
```
