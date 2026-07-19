import { describe, it, expect } from "vitest";
import { eventsToIcs, toIcsUtc, escapeIcsText, foldLine } from "../../src/calendar/ics.js";
import type { CalendarEntity, CalendarEvent } from "../../src/calendar/types.js";

function ev(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 1,
    entity_id: 1,
    type: "downtime",
    title: "event",
    notes: null,
    starts_at: "2026-08-01T10:00:00.000Z",
    ends_at: "2026-08-01T12:00:00.000Z",
    original_timezone: null,
    source: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const entity: CalendarEntity = {
  id: 1, name: "app-01", kind: "server", notes: null, timezone: null, active: true,
  created_at: "", updated_at: "",
};

describe("toIcsUtc", () => {
  it("formats a UTC ISO timestamp", () => {
    expect(toIcsUtc("2026-08-01T10:00:00Z")).toBe("20260801T100000Z");
  });
});

describe("escapeIcsText", () => {
  it("escapes commas, semicolons, backslashes, and newlines", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
});

describe("foldLine", () => {
  it("leaves short lines untouched", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds lines over 75 octets with CRLF + space continuation", () => {
    const long = "SUMMARY:" + "x".repeat(100);
    const folded = foldLine(long);
    const segments = folded.split("\r\n ");
    expect(segments.length).toBeGreaterThan(1);
    expect(Buffer.from(segments[0], "utf8").length).toBeLessThanOrEqual(75);
    expect(segments.join("")).toBe(long);
  });
});

describe("eventsToIcs", () => {
  it("wraps output in VCALENDAR with CRLF line endings", () => {
    const ics = eventsToIcs([], new Map());
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("emits one VEVENT per event with expected fields", () => {
    const events = [ev({ id: 42, title: "Patch window" })];
    const ics = eventsToIcs(events, new Map([[1, entity]]));
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:kontexta-cal-42@kontexta");
    expect(ics).toContain("DTSTART:20260801T100000Z");
    expect(ics).toContain("DTEND:20260801T120000Z");
    expect(ics).toContain("SUMMARY:[app-01] Patch window");
    expect(ics).toContain("CATEGORIES:downtime");
    expect(ics).toContain("END:VEVENT");
  });

  it("keeps UID stable across calls for the same event id", () => {
    const events = [ev({ id: 7 })];
    const first = eventsToIcs(events, new Map([[1, entity]]));
    const second = eventsToIcs(events, new Map([[1, entity]]));
    expect(first).toContain("UID:kontexta-cal-7@kontexta");
    expect(second).toContain("UID:kontexta-cal-7@kontexta");
  });

  it("produces a valid empty calendar for an empty event list", () => {
    const ics = eventsToIcs([], new Map());
    expect(ics).toBe("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kontexta//Calendar//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Kontexta Calendar\r\nEND:VCALENDAR\r\n");
  });
});
