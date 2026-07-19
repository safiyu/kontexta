// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { AgendaList } from "./agenda-list";
import type { CalendarEntity, CalendarEvent, Conflict } from "kxta-core";

afterEach(() => {
  cleanup();
});

const entity: CalendarEntity = {
  id: 1, name: "app-01", kind: "server", notes: null, timezone: null, active: true,
  created_at: "", updated_at: "",
};

function ev(overrides: Partial<CalendarEvent> & { id: number; starts_at: string; ends_at: string }): CalendarEvent {
  return {
    entity_id: 1, type: "downtime", title: "event", notes: null,
    original_timezone: null, source: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AgendaList", () => {
  it("groups events by day and renders titles", () => {
    const events = [
      ev({ id: 1, title: "First event", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T11:00:00Z" }),
      ev({ id: 2, title: "Second event", starts_at: "2026-08-02T10:00:00Z", ends_at: "2026-08-02T11:00:00Z" }),
    ];
    render(
      <AgendaList
        events={events}
        entitiesById={new Map([[1, entity]])}
        conflicts={[]}
        loading={false}
        highlightIds={new Set()}
        onEventClick={() => {}}
      />
    );
    expect(screen.getByText("First event")).toBeTruthy();
    expect(screen.getByText("Second event")).toBeTruthy();
  });

  it("shows a conflict badge only on the conflicted event", () => {
    const events = [
      ev({ id: 1, title: "Conflicted", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T11:00:00Z" }),
      ev({ id: 2, title: "Peaceful", starts_at: "2026-08-02T10:00:00Z", ends_at: "2026-08-02T11:00:00Z" }),
    ];
    const conflict: Conflict = {
      kind: "overlap",
      event_a: events[0],
      event_b: events[0],
      entity_a: { id: 1, name: "app-01" },
      entity_b: { id: 1, name: "app-01" },
      link: null,
      gap_minutes: null,
      reason: "overlapping windows",
    };
    render(
      <AgendaList
        events={events}
        entitiesById={new Map([[1, entity]])}
        conflicts={[conflict]}
        loading={false}
        highlightIds={new Set()}
        onEventClick={() => {}}
      />
    );
    const badges = screen.getAllByText("Conflict");
    expect(badges.length).toBe(1);
  });

  it("fires onEventClick when a row is clicked", () => {
    const events = [ev({ id: 1, title: "Clickable", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T11:00:00Z" })];
    const onEventClick = vi.fn();
    render(
      <AgendaList
        events={events}
        entitiesById={new Map([[1, entity]])}
        conflicts={[]}
        loading={false}
        highlightIds={new Set()}
        onEventClick={onEventClick}
      />
    );
    fireEvent.click(screen.getByText("Clickable"));
    expect(onEventClick).toHaveBeenCalledWith(events[0]);
  });

  it("shows an empty state when there are no events", () => {
    render(
      <AgendaList
        events={[]}
        entitiesById={new Map()}
        conflicts={[]}
        loading={false}
        highlightIds={new Set()}
        onEventClick={() => {}}
      />
    );
    expect(screen.getByText(/No events in the next 30 days/)).toBeTruthy();
  });
});
