import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { createEntity, linkEntities, createEvent } from "../../src/calendar/repository.js";
import { setSetting } from "../../src/metadata/settings.js";
import {
  detectConflicts, getBufferMinutes, findConflicts, BUFFER_SETTING_KEY,
} from "../../src/calendar/conflicts.js";
import type { CalendarEntity, CalendarEvent, CalendarLink } from "../../src/calendar/types.js";

function ev(overrides: Partial<CalendarEvent> & { entity_id: number; starts_at: string; ends_at: string }): CalendarEvent {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1_000_000),
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

describe("detectConflicts (pure)", () => {
  const entities: CalendarEntity[] = [
    { id: 1, name: "a", kind: null, notes: null, timezone: null, active: true, created_at: "", updated_at: "" },
    { id: 2, name: "b", kind: null, notes: null, timezone: null, active: true, created_at: "", updated_at: "" },
    { id: 3, name: "c", kind: null, notes: null, timezone: null, active: true, created_at: "", updated_at: "" },
  ];

  it("flags a same-entity overlap", () => {
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 1, starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    const conflicts = detectConflicts({ events, links: [], entities, buffer_minutes: 0 });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("overlap");
  });

  it("treats back-to-back events as no overlap, but flags them under a buffer", () => {
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 1, starts_at: "2026-08-01T12:00:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    expect(detectConflicts({ events, links: [], entities, buffer_minutes: 0 })).toHaveLength(0);

    const withBuffer = detectConflicts({ events, links: [], entities, buffer_minutes: 30 });
    expect(withBuffer).toHaveLength(1);
    expect(withBuffer[0].kind).toBe("insufficient_buffer");
    expect(withBuffer[0].gap_minutes).toBe(0);
  });

  it("does not flag a gap exactly equal to the buffer (strict <)", () => {
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 1, starts_at: "2026-08-01T12:30:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    expect(detectConflicts({ events, links: [], entities, buffer_minutes: 30 })).toHaveLength(0);
    expect(detectConflicts({ events, links: [], entities, buffer_minutes: 31 })).toHaveLength(1);
  });

  it("flags overlaps between linked entities, either link direction", () => {
    const link: CalendarLink = { id: 1, from_entity_id: 1, to_entity_id: 2, label: "feeds", created_at: "" };
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 2, starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    const conflicts = detectConflicts({ events, links: [link], entities, buffer_minutes: 0 });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("linked_overlap");
    expect(conflicts[0].link?.label).toBe("feeds");

    const reverseLink: CalendarLink = { id: 2, from_entity_id: 2, to_entity_id: 1, label: "feeds", created_at: "" };
    const reverseConflicts = detectConflicts({ events, links: [reverseLink], entities, buffer_minutes: 0 });
    expect(reverseConflicts).toHaveLength(1);
  });

  it("does not flag overlaps between unlinked entities", () => {
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 2, starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    expect(detectConflicts({ events, links: [], entities, buffer_minutes: 0 })).toHaveLength(0);
  });

  it("does not traverse beyond one hop", () => {
    const links: CalendarLink[] = [
      { id: 1, from_entity_id: 1, to_entity_id: 2, label: null, created_at: "" },
      { id: 2, from_entity_id: 2, to_entity_id: 3, label: null, created_at: "" },
    ];
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 3, starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    expect(detectConflicts({ events, links, entities, buffer_minutes: 0 })).toHaveLength(0);
  });

  it("flags a buffer conflict between linked entities", () => {
    const link: CalendarLink = { id: 1, from_entity_id: 1, to_entity_id: 2, label: null, created_at: "" };
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 2, starts_at: "2026-08-01T12:15:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    const conflicts = detectConflicts({ events, links: [link], entities, buffer_minutes: 30 });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("insufficient_buffer");
    expect(conflicts[0].gap_minutes).toBe(15);
  });

  it("reports only one conflict per pair, preferring overlap over buffer", () => {
    const events = [
      ev({ id: 1, entity_id: 1, starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ev({ id: 2, entity_id: 1, starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" }),
    ];
    const conflicts = detectConflicts({ events, links: [], entities, buffer_minutes: 60 });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("overlap");
  });

  it("returns conflicts in deterministic order", () => {
    const events = [
      ev({ id: 3, entity_id: 1, starts_at: "2026-08-03T00:00:00Z", ends_at: "2026-08-03T02:00:00Z" }),
      ev({ id: 4, entity_id: 1, starts_at: "2026-08-03T01:00:00Z", ends_at: "2026-08-03T03:00:00Z" }),
      ev({ id: 1, entity_id: 2, starts_at: "2026-08-01T00:00:00Z", ends_at: "2026-08-01T02:00:00Z" }),
      ev({ id: 2, entity_id: 2, starts_at: "2026-08-01T01:00:00Z", ends_at: "2026-08-01T03:00:00Z" }),
    ];
    const conflicts = detectConflicts({ events, links: [], entities, buffer_minutes: 0 });
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].event_a.id).toBe(1);
    expect(conflicts[1].event_a.id).toBe(3);
  });
});

describe("getBufferMinutes / findConflicts (DB-backed)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-cal-conflicts-test-"));
    createDatabase(join(testDir, "test.db"));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("defaults to 0 when unset", () => {
    expect(getBufferMinutes()).toBe(0);
  });

  it("reads the configured value", () => {
    setSetting(BUFFER_SETTING_KEY, "45");
    expect(getBufferMinutes()).toBe(45);
  });

  it("falls back to 0 on a garbage value", () => {
    setSetting(BUFFER_SETTING_KEY, "not-a-number");
    expect(getBufferMinutes()).toBe(0);
  });

  it("lets a per-call override beat the settings default", () => {
    setSetting(BUFFER_SETTING_KEY, "60");
    const a = createEntity({ name: "a" });
    createEvent({ entity_id: a.id, type: "t", title: "e1", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" });
    createEvent({ entity_id: a.id, type: "t", title: "e2", starts_at: "2026-08-01T12:10:00Z", ends_at: "2026-08-01T13:00:00Z" });

    const withDefault = findConflicts({ from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z" });
    expect(withDefault.buffer_minutes).toBe(60);
    expect(withDefault.conflicts).toHaveLength(1);

    const withOverride = findConflicts({ from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z", buffer_minutes: 5 });
    expect(withOverride.buffer_minutes).toBe(5);
    expect(withOverride.conflicts).toHaveLength(0);
  });

  it("scopes to an entity while still detecting conflicts with its linked neighbors", () => {
    const a = createEntity({ name: "a" });
    const b = createEntity({ name: "b" });
    const c = createEntity({ name: "c" });
    linkEntities(a.id, b.id, "feeds");
    createEvent({ entity_id: a.id, type: "t", title: "e1", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" });
    createEvent({ entity_id: b.id, type: "t", title: "e2", starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" });
    createEvent({ entity_id: c.id, type: "t", title: "e3", starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" });

    const result = findConflicts({ from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z", entity_ids: [a.id] });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe("linked_overlap");
  });
});
