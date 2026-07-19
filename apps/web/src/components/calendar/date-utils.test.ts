import { describe, it, expect } from "vitest";
import {
  monthGrid, startOfWeek, toDatetimeLocalValue, fromDatetimeLocalValue,
  eventTouchesDay, layoutDayEvents, addDays,
} from "./date-utils";
import type { CalendarEvent } from "kxta-core";

function ev(overrides: Partial<CalendarEvent> & { starts_at: string; ends_at: string }): CalendarEvent {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1_000_000),
    entity_id: 1,
    type: "downtime",
    title: "event",
    notes: null,
    original_timezone: null,
    source: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("monthGrid", () => {
  it("returns 42 cells starting on a Monday", () => {
    const grid = monthGrid(new Date(2026, 6, 17)); // July 2026
    expect(grid.length).toBe(42);
    expect(grid[0].getDay()).toBe(1); // Monday
  });

  it("includes every day of the anchor month", () => {
    const anchor = new Date(2026, 6, 17); // July 2026 (31 days)
    const grid = monthGrid(anchor);
    const julyDays = grid.filter((d) => d.getMonth() === 6 && d.getFullYear() === 2026);
    expect(julyDays.length).toBe(31);
  });
});

describe("startOfWeek", () => {
  it("returns the previous Monday for a Sunday", () => {
    const sunday = new Date(2026, 6, 19); // a Sunday
    expect(sunday.getDay()).toBe(0);
    const monday = startOfWeek(sunday);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(13);
  });
});

describe("datetime-local round trip", () => {
  it("preserves the instant to the minute", () => {
    const iso = "2026-07-17T09:30:00.000Z";
    const local = toDatetimeLocalValue(iso);
    const back = fromDatetimeLocalValue(local);
    expect(new Date(back).getTime()).toBe(new Date(iso).getTime());
  });
});

describe("eventTouchesDay", () => {
  it("uses half-open semantics — an event ending exactly at midnight excludes the next day", () => {
    // Construct day boundaries and event instants both in local time (as
    // startOfDay does internally) to keep the test independent of the
    // runner's timezone.
    const day1 = new Date(2026, 6, 17);
    const day2 = new Date(2026, 6, 18);
    const e = ev({
      starts_at: new Date(2026, 6, 17, 22, 0, 0).toISOString(),
      ends_at: new Date(2026, 6, 18, 0, 0, 0).toISOString(),
    });
    expect(eventTouchesDay(e, day1)).toBe(true);
    expect(eventTouchesDay(e, day2)).toBe(false);
  });
});

describe("layoutDayEvents", () => {
  const day = new Date(2026, 6, 17);

  it("assigns 3 lanes to 3 mutually overlapping events", () => {
    const events = [
      ev({ id: 1, starts_at: "2026-07-17T09:00:00Z", ends_at: "2026-07-17T11:00:00Z" }),
      ev({ id: 2, starts_at: "2026-07-17T09:30:00Z", ends_at: "2026-07-17T10:30:00Z" }),
      ev({ id: 3, starts_at: "2026-07-17T10:00:00Z", ends_at: "2026-07-17T12:00:00Z" }),
    ];
    const positioned = layoutDayEvents(events, day);
    expect(positioned.length).toBe(3);
    expect(positioned.every((p) => p.lanes === 3)).toBe(true);
    const lanes = positioned.map((p) => p.lane).sort();
    expect(lanes).toEqual([0, 1, 2]);
  });

  it("gives disjoint events lane 0 of 1", () => {
    const events = [
      ev({ id: 1, starts_at: "2026-07-17T09:00:00Z", ends_at: "2026-07-17T10:00:00Z" }),
      ev({ id: 2, starts_at: "2026-07-17T11:00:00Z", ends_at: "2026-07-17T12:00:00Z" }),
    ];
    const positioned = layoutDayEvents(events, day);
    expect(positioned.every((p) => p.lane === 0 && p.lanes === 1)).toBe(true);
  });

  it("clamps a midnight-crossing event to the day bounds", () => {
    const events = [
      ev({
        id: 1,
        starts_at: new Date(2026, 6, 16, 22, 0, 0).toISOString(),
        ends_at: new Date(2026, 6, 17, 2, 0, 0).toISOString(),
      }),
    ];
    const positioned = layoutDayEvents(events, day);
    expect(positioned[0].topMin).toBe(0);
  });
});

describe("addDays", () => {
  it("advances by n days", () => {
    const d = addDays(new Date(2026, 6, 17), 5);
    expect(d.getDate()).toBe(22);
  });
});
