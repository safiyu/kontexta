import type { CalendarEvent } from "kxta-core";

// --- Timezone bridge -------------------------------------------------------
// Core stores UTC ISO and rejects naive timestamps. The UI works entirely in
// browser-local wall clock via <input type="datetime-local">.

/** UTC ISO ("2026-07-17T09:00:00.000Z") -> local datetime-local value ("2026-07-17T11:00"). */
export function toDatetimeLocalValue(isoUtc: string): string {
  const d = new Date(isoUtc);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local value (local wall clock, no offset) -> UTC ISO with explicit Z. */
export function fromDatetimeLocalValue(value: string): string {
  // A value with no timezone suffix ("YYYY-MM-DDTHH:mm") is parsed as LOCAL
  // time per the Date constructor spec; toISOString() then emits UTC "Z".
  return new Date(value).toISOString();
}

// --- Date math (Monday week start — change WEEK_START_OFFSET to switch) ---

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Monday of the week containing d. */
export function startOfWeek(d: Date): Date {
  const day = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  return startOfDay(addDays(d, -day));
}

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

/** The 7 days (Mon..Sun) of the week containing anchor. */
export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export const HOURS = Array.from({ length: 24 }, (_, i) => i);

export type ViewMode = "month" | "week" | "agenda";

/** Half-open [from, to) window for the given view/anchor. */
export function visibleRange(view: ViewMode, anchor: Date): { from: Date; to: Date } {
  if (view === "month") {
    const grid = monthGrid(anchor);
    return { from: grid[0], to: addDays(grid[grid.length - 1], 1) };
  }
  if (view === "week") {
    const start = startOfWeek(anchor);
    return { from: start, to: addDays(start, 7) };
  }
  const start = startOfDay(anchor);
  return { from: start, to: addDays(start, 30) };
}

/** Half-open day membership — an event ending exactly at midnight does NOT touch the next day. */
export function eventTouchesDay(ev: { starts_at: string; ends_at: string }, day: Date): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;
  return new Date(ev.starts_at).getTime() < dayEnd && new Date(ev.ends_at).getTime() > dayStart;
}

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

// --- Week-view lane layout --------------------------------------------------

export interface PositionedEvent {
  event: CalendarEvent;
  lane: number; // 0-based column within its overlap cluster
  lanes: number; // total lanes in that cluster (width divisor)
  topMin: number; // minutes from midnight, clamped to [0, 1440]
  heightMin: number; // clamped duration in minutes within this day, min 20 for clickability
}

/** Position same-day events into side-by-side lanes so overlaps are visually obvious. */
export function layoutDayEvents(events: CalendarEvent[], day: Date): PositionedEvent[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;

  const clamped = events
    .filter((ev) => eventTouchesDay(ev, day))
    .map((ev) => {
      const startMs = Math.max(new Date(ev.starts_at).getTime(), dayStart);
      const endMs = Math.min(new Date(ev.ends_at).getTime(), dayEnd);
      const topMin = (startMs - dayStart) / 60_000;
      const endMin = (endMs - dayStart) / 60_000;
      return { event: ev, topMin, endMin };
    })
    .sort((a, b) => (a.topMin !== b.topMin ? a.topMin - b.topMin : b.endMin - a.endMin));

  const positioned: PositionedEvent[] = [];
  let clusterStart = 0;

  while (clusterStart < clamped.length) {
    let clusterEnd = clamped[clusterStart].endMin;
    let clusterStop = clusterStart + 1;
    while (clusterStop < clamped.length && clamped[clusterStop].topMin < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, clamped[clusterStop].endMin);
      clusterStop++;
    }

    const cluster = clamped.slice(clusterStart, clusterStop);
    const laneEnds: number[] = [];
    const laneOf: number[] = [];
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.topMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.endMin);
      } else {
        laneEnds[lane] = item.endMin;
      }
      laneOf.push(lane);
    }
    const lanes = laneEnds.length;
    cluster.forEach((item, i) => {
      positioned.push({
        event: item.event,
        lane: laneOf[i],
        lanes,
        topMin: item.topMin,
        heightMin: Math.max(item.endMin - item.topMin, 20),
      });
    });

    clusterStart = clusterStop;
  }

  return positioned;
}

// --- Display formatters (local time) ---------------------------------------

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtDayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

export function fmtMonthTitle(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** to is exclusive; displays the inclusive last day. */
export function fmtRangeLabel(from: Date, to: Date): string {
  const lastDay = addDays(to, -1);
  const sameMonth = from.getMonth() === lastDay.getMonth() && from.getFullYear() === lastDay.getFullYear();
  const startStr = from.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  const endStr = lastDay.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${startStr} – ${endStr}`;
}
