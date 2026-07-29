# Calendar Week View All-Day Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull full-day events out of the week view's hourly grid into a dedicated all-day row, so the hourly grid's lane layout stops being crowded and unreadable when several full-day events overlap on the same day.

**Architecture:** A new pure function `isAllDayForDay()` in `date-utils.ts` classifies an event as "all-day" for a given day (clamped duration ≥23h). `week-view.tsx` uses it twice: to build a new all-day row above the hourly grid (reusing the existing `EventChip` component), and to exclude those same events from the hourly grid's `layoutDayEvents()` lane computation.

**Tech Stack:** Next.js (App Router), React, TypeScript, Tailwind CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-calendar-week-allday-design.md`

## Global Constraints

- No git co-author trailers; commit as `safiyu <dheensafiyu@gmail.com>`.
- All three themes (light, dark, Blueprint) are first-class — verify no regression in any of them.
- No new hardcoded colors. The all-day row's own chrome (label text, row border) uses only `--border` and `--muted`, both already defined for all three themes in `apps/web/src/app/globals.css`. The all-day row's event pills reuse the existing `EventChip` component (already themed) rather than any new markup/colors.

---

### Task 1: `isAllDayForDay()` in `date-utils.ts`

**Files:**
- Modify: `apps/web/src/components/calendar/date-utils.ts` (add the function after `eventTouchesDay`, around line 93)
- Modify: `apps/web/src/components/calendar/date-utils.test.ts` (add a new describe block, update the import line)

**Interfaces:**
- Consumes: `eventTouchesDay(ev, day): boolean` and `startOfDay(d): Date` (both already exist in `date-utils.ts`, unchanged).
- Produces: `isAllDayForDay(ev: CalendarEvent, day: Date): boolean` — new exported function. Task 2 imports and calls this exact name/signature twice (to build the all-day row's per-day event lists, and to filter events out of the hourly grid's lane computation).

- [ ] **Step 1: Write the failing tests**

Open `apps/web/src/components/calendar/date-utils.test.ts`. Update the import line to add `isAllDayForDay`:

```ts
import {
  monthGrid, startOfWeek, toDatetimeLocalValue, fromDatetimeLocalValue,
  eventTouchesDay, layoutDayEvents, addDays, visibleRange, maxVisibleForWeeks,
  isAllDayForDay,
} from "./date-utils";
```

Insert a new describe block immediately after the existing `describe("eventTouchesDay", ...)` block (which ends right before `describe("layoutDayEvents", ...)`):

```ts
describe("isAllDayForDay", () => {
  const day = new Date(2026, 6, 17); // Jul 17, 2026

  it("is true for an exact midnight-to-midnight event", () => {
    const e = ev({
      starts_at: new Date(2026, 6, 17, 0, 0, 0).toISOString(),
      ends_at: new Date(2026, 6, 18, 0, 0, 0).toISOString(),
    });
    expect(isAllDayForDay(e, day)).toBe(true);
  });

  it("is true for the existing 00:00-23:59 data convention", () => {
    const e = ev({
      starts_at: new Date(2026, 6, 17, 0, 0, 0).toISOString(),
      ends_at: new Date(2026, 6, 17, 23, 59, 0).toISOString(),
    });
    expect(isAllDayForDay(e, day)).toBe(true);
  });

  it("is true at exactly the 23-hour threshold", () => {
    const e = ev({
      starts_at: new Date(2026, 6, 17, 0, 0, 0).toISOString(),
      ends_at: new Date(2026, 6, 17, 23, 0, 0).toISOString(),
    });
    expect(isAllDayForDay(e, day)).toBe(true);
  });

  it("is false just under the 23-hour threshold", () => {
    const e = ev({
      starts_at: new Date(2026, 6, 17, 0, 1, 0).toISOString(),
      ends_at: new Date(2026, 6, 17, 23, 0, 0).toISOString(),
    });
    expect(isAllDayForDay(e, day)).toBe(false);
  });

  it("is false for an ordinary multi-hour timed event", () => {
    const e = ev({
      starts_at: new Date(2026, 6, 17, 9, 0, 0).toISOString(),
      ends_at: new Date(2026, 6, 17, 17, 0, 0).toISOString(),
    });
    expect(isAllDayForDay(e, day)).toBe(false);
  });

  it("is false for an event that doesn't touch the given day", () => {
    const e = ev({
      starts_at: new Date(2026, 6, 18, 0, 0, 0).toISOString(),
      ends_at: new Date(2026, 6, 19, 0, 0, 0).toISOString(),
    });
    expect(isAllDayForDay(e, day)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kxta-web test date-utils`
Expected: FAIL — `isAllDayForDay` is not exported yet, so every test in the new describe block fails with an import/undefined error.

- [ ] **Step 3: Implement `isAllDayForDay()`**

In `apps/web/src/components/calendar/date-utils.ts`, insert this new function immediately after `eventTouchesDay` (which currently ends at line 93) and before the `// --- Week-view lane layout ---` comment:

```ts
const ALL_DAY_THRESHOLD_MIN = 23 * 60; // 1380 minutes

/** True if `ev`, clamped to `day`'s bounds, covers at least ALL_DAY_THRESHOLD_MIN
 *  minutes of that day — i.e. effectively a full-day event for rendering purposes. */
export function isAllDayForDay(ev: CalendarEvent, day: Date): boolean {
  if (!eventTouchesDay(ev, day)) return false;
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;
  const clampedStart = Math.max(new Date(ev.starts_at).getTime(), dayStart);
  const clampedEnd = Math.min(new Date(ev.ends_at).getTime(), dayEnd);
  return (clampedEnd - clampedStart) / 60_000 >= ALL_DAY_THRESHOLD_MIN;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kxta-web test date-utils`
Expected: PASS — all 6 new `isAllDayForDay` tests green, plus every pre-existing test in the file (`monthGrid`, `startOfWeek`, `visibleRange`, `maxVisibleForWeeks`, datetime-local round trip, `eventTouchesDay`, `layoutDayEvents`, `addDays`) still green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/calendar/date-utils.ts apps/web/src/components/calendar/date-utils.test.ts
git commit -m "feat(web): add isAllDayForDay to classify full-day calendar events"
```

---

### Task 2: All-day row in `WeekView`

**Files:**
- Modify: `apps/web/src/components/calendar/week-view.tsx` (whole file — changes are pervasive enough that the full replacement is given below)

**Interfaces:**
- Consumes: `isAllDayForDay(ev: CalendarEvent, day: Date): boolean` from Task 1's `date-utils.ts` (already implemented and tested by this point); `startOfDay(d: Date): Date` from `date-utils.ts` (pre-existing, not previously imported by this file); `EventChip` from `./event-chip` (pre-existing component, already used by `month-grid.tsx` — props are `event`, `entityName`, `conflicted`, `highlighted`, `onClick`).
- Produces: no new exports — `WeekView`'s props (`WeekViewProps`) are unchanged, so `calendar-client.tsx` needs no changes for this task.

No new unit tests here: `WeekView` is a visual component with no existing test file (this codebase's calendar tests cover pure `date-utils` logic and `agenda-list`'s grouping logic — not week-view's rendering), so this task is verified manually per Step 3 below, consistent with that existing pattern (the same convention already applied to `month-grid.tsx`'s dynamic-rows task).

- [ ] **Step 1: Replace `week-view.tsx` with the all-day-row version**

Replace the full contents of `apps/web/src/components/calendar/week-view.tsx` with:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEntity, CalendarEvent } from "kxta-core";
import { weekDays, layoutDayEvents, isSameDay, startOfDay, isAllDayForDay, HOURS, fmtTime, fmtDayLabel } from "./date-utils";
import { colorForType } from "./event-colors";
import { EventChip } from "./event-chip";

interface WeekViewProps {
  anchor: Date;
  events: CalendarEvent[];
  entitiesById: Map<number, CalendarEntity>;
  conflictEventIds: Set<number>;
  highlightIds: Set<number>;
  loading: boolean;
  onSlotClick: (day: Date, hour: number) => void;
  onEventClick: (ev: CalendarEvent) => void;
}

const PX_PER_HOUR = 48;

function dayKey(d: Date): string {
  return startOfDay(d).toISOString();
}

function CurrentTimeIndicator({ day }: { day: Date }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!isSameDay(day, now)) return null;
  const top = (now.getHours() * 60 + now.getMinutes()) * (PX_PER_HOUR / 60);
  return (
    <div className="absolute left-0 right-0 pointer-events-none z-10" style={{ top }}>
      <div className="h-px bg-amber-accent shadow-[0_0_6px_var(--accent-soft)]" />
      <div className="w-2 h-2 rounded-full bp-keep-round bg-amber-accent -ml-1 -mt-1" />
    </div>
  );
}

export function WeekView({ anchor, events, entitiesById, conflictEventIds, highlightIds, loading, onSlotClick, onEventClick }: WeekViewProps) {
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const today = new Date();

  const allDayEventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const day of days) {
      map.set(dayKey(day), events.filter((ev) => isAllDayForDay(ev, day)));
    }
    return map;
  }, [days, events]);

  const hasAnyAllDay = useMemo(
    () => [...allDayEventsByDay.values()].some((list) => list.length > 0),
    [allDayEventsByDay],
  );

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 8 * PX_PER_HOUR;
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden p-4 gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton h-8 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex sticky top-0 z-10 bg-[var(--bg-secondary)]/80 backdrop-blur-xl border-b border-[var(--border)]">
        <div className="w-14 shrink-0" />
        <div className="grid grid-cols-7 flex-1">
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className={`text-center py-2 text-xs font-bold ${isSameDay(day, today) ? "text-amber-accent" : "text-[var(--text-secondary)]"}`}
            >
              {fmtDayLabel(day)}
            </div>
          ))}
        </div>
      </div>

      {hasAnyAllDay && (
        <div className="flex border-b border-[var(--border)] shrink-0">
          <div className="w-14 shrink-0 flex items-start justify-end pr-2 pt-1.5">
            <span className="text-[9px] uppercase tracking-widest text-[var(--muted)]">All-day</span>
          </div>
          <div className="grid grid-cols-7 flex-1">
            {days.map((day) => (
              <div key={day.toISOString()} className="border-l border-[var(--border)] p-1 flex flex-col gap-1">
                {(allDayEventsByDay.get(dayKey(day)) ?? []).map((ev) => (
                  <EventChip
                    key={ev.id}
                    event={ev}
                    entityName={entitiesById.get(ev.entity_id)?.name ?? `#${ev.entity_id}`}
                    conflicted={conflictEventIds.has(ev.id)}
                    highlighted={highlightIds.has(ev.id)}
                    onClick={() => onEventClick(ev)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={bodyRef} className="flex-1 overflow-y-auto flex">
        <div className="w-14 shrink-0">
          {HOURS.map((h) => (
            <div key={h} className="text-[10px] text-[var(--muted)] text-right pr-2 font-mono" style={{ height: PX_PER_HOUR }}>
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 flex-1">
          {days.map((day) => {
            const positioned = layoutDayEvents(events.filter((ev) => !isAllDayForDay(ev, day)), day);
            return (
              <div
                key={day.toISOString()}
                className="relative border-l border-[var(--border)]"
                style={{ height: 24 * PX_PER_HOUR }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const offsetY = e.clientY - rect.top;
                  onSlotClick(day, Math.floor(offsetY / PX_PER_HOUR));
                }}
              >
                {HOURS.map((h) => (
                  <div key={h} className="absolute left-0 right-0 border-t border-[var(--border)]" style={{ top: h * PX_PER_HOUR }} />
                ))}

                <CurrentTimeIndicator day={day} />

                {positioned.map(({ event, lane, lanes, topMin, heightMin }) => {
                  const color = colorForType(event.type);
                  const entityName = entitiesById.get(event.entity_id)?.name ?? `#${event.entity_id}`;
                  return (
                    <button
                      key={event.id}
                      id={`cal-ev-${event.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick(event);
                      }}
                      className={`absolute rounded-md border px-1.5 py-0.5 text-[11px] leading-tight overflow-hidden text-left cursor-pointer ${color.chip} ${
                        conflictEventIds.has(event.id) ? "ring-1 ring-red-400/70" : ""
                      } ${highlightIds.has(event.id) ? "ring-2 ring-red-400" : ""}`}
                      style={{
                        top: topMin * (PX_PER_HOUR / 60),
                        height: heightMin * (PX_PER_HOUR / 60),
                        left: `${(lane / lanes) * 100}%`,
                        width: `calc(${100 / lanes}% - 2px)`,
                      }}
                      title={`${entityName} — ${event.title}`}
                    >
                      <div className="font-semibold truncate">
                        <span className="font-bold">{entityName}</span> · {event.title}
                      </div>
                      <div className="opacity-70 font-mono text-[10px]">
                        {fmtTime(event.starts_at)}–{fmtTime(event.ends_at)}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

Three things changed from the original file, all covered above: (1) the `dayKey` helper and two new imports (`startOfDay`, `isAllDayForDay` from `./date-utils`; `EventChip` from `./event-chip`); (2) the new `allDayEventsByDay`/`hasAnyAllDay` memos and the all-day row JSX block, inserted between the sticky day-header and the scrollable hourly-grid body; (3) `layoutDayEvents(events, day)` changed to `layoutDayEvents(events.filter((ev) => !isAllDayForDay(ev, day)), day)` so the hourly grid no longer lays out events already shown in the all-day row.

- [ ] **Step 2: Run the existing calendar test suite**

Run: `pnpm --filter kxta-web test calendar`
Expected: PASS (no test directly exercises `WeekView`, but this confirms the new `date-utils` imports — `startOfDay`, `isAllDayForDay` — and the `EventChip` import resolve correctly and nothing else broke).

- [ ] **Step 3: Run a full build to catch type errors**

Run: `pnpm --filter kxta-web build`
Expected: PASS — confirms `EventChip`'s prop types match what's passed, and that no other file imports something from `week-view.tsx` that changed (nothing does — `WeekViewProps` is unchanged).

- [ ] **Step 4: Manually verify in the browser**

With the dev server running (`pnpm --filter kxta-web dev`), open `/calendar`, switch to Week view, and navigate to a week containing full-day events (e.g. the week of Jul 20-26, 2026, if that data still exists — otherwise create a couple of test events spanning 00:00–23:59 on the same day to reproduce the original clutter):
- Confirm the full-day events now appear in a row directly under the day headers, above the hourly grid, each as a chip matching the month view's chip style.
- Confirm the hourly grid's lanes are back to normal width — no more single-character-truncated event text from full-day events crowding the grid.
- Click a chip in the all-day row — it should open the same edit dialog as clicking any other event.
- Navigate to a week with no full-day events — confirm no empty all-day row appears (the row should be entirely absent, not just empty).
- If a day has several full-day events, confirm the row grows taller to show all of them (no "+N more" collapse) and the hourly grid area below shrinks but remains scrollable.
- Repeat in light, dark, and Blueprint themes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/calendar/week-view.tsx
git commit -m "feat(web): move full-day events into a week-view all-day row"
```
