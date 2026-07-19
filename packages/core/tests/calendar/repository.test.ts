import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import {
  createEntity, updateEntity, deleteEntity, getEntity, getEntityByName, listEntities,
  linkEntities, unlinkEntities, listLinks,
  createEvent, updateEvent, deleteEvent, getEvent, listEvents,
} from "../../src/calendar/repository.js";

describe("calendar repository", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-cal-test-"));
    createDatabase(join(testDir, "test.db"));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("entities", () => {
    it("creates and reads an entity back", () => {
      const e = createEntity({ name: "app-01", kind: "server", notes: "primary app node" });
      expect(e.id).toBeGreaterThan(0);
      expect(e.name).toBe("app-01");
      expect(e.active).toBe(true);
      expect(getEntity(e.id)?.name).toBe("app-01");
    });

    it("rejects duplicate names, case-insensitively", () => {
      createEntity({ name: "PRD" });
      expect(() => createEntity({ name: "prd" })).toThrow(/already exists/);
    });

    it("rejects an invalid IANA timezone", () => {
      expect(() => createEntity({ name: "x", timezone: "Not/AZone" })).toThrow(/Unknown IANA timezone/);
    });

    it("accepts a valid IANA timezone", () => {
      const e = createEntity({ name: "x", timezone: "Europe/Berlin" });
      expect(e.timezone).toBe("Europe/Berlin");
    });

    it("updates fields and bumps updated_at", async () => {
      const e = createEntity({ name: "x" });
      await new Promise((r) => setTimeout(r, 5));
      const updated = updateEntity(e.id, { kind: "service", active: false });
      expect(updated.kind).toBe("service");
      expect(updated.active).toBe(false);
      expect(updated.updated_at).not.toBe(e.updated_at);
    });

    it("rejects a rename collision", () => {
      createEntity({ name: "a" });
      const b = createEntity({ name: "b" });
      expect(() => updateEntity(b.id, { name: "a" })).toThrow(/already exists/);
    });

    it("filters by active_only and kind", () => {
      createEntity({ name: "a", kind: "server" });
      const b = createEntity({ name: "b", kind: "service" });
      updateEntity(b.id, { active: false });

      expect(listEntities({ active_only: true }).map((e) => e.name)).toEqual(["a"]);
      expect(listEntities({ kind: "service" }).map((e) => e.name)).toEqual(["b"]);
    });

    it("looks up by name case-insensitively", () => {
      createEntity({ name: "PRD" });
      expect(getEntityByName("prd")?.name).toBe("PRD");
    });

    it("cascade-deletes events and links, reporting counts", () => {
      const a = createEntity({ name: "a" });
      const b = createEntity({ name: "b" });
      linkEntities(a.id, b.id, "feeds");
      createEvent({ entity_id: a.id, type: "downtime", title: "e1", starts_at: "2026-08-01T00:00:00Z", ends_at: "2026-08-01T01:00:00Z" });
      createEvent({ entity_id: a.id, type: "downtime", title: "e2", starts_at: "2026-08-02T00:00:00Z", ends_at: "2026-08-02T01:00:00Z" });

      const result = deleteEntity(a.id);
      expect(result).toEqual({ deleted_events: 2, deleted_links: 1 });
      expect(getEntity(a.id)).toBeNull();
      expect(listLinks(b.id)).toEqual([]);
    });
  });

  describe("links", () => {
    it("creates a link and upserts the label on repeat calls", () => {
      const a = createEntity({ name: "a" });
      const b = createEntity({ name: "b" });
      linkEntities(a.id, b.id, "feeds");
      const updated = linkEntities(a.id, b.id, "replicates into");
      expect(updated.label).toBe("replicates into");
      expect(listLinks().length).toBe(1);
    });

    it("rejects a self-link", () => {
      const a = createEntity({ name: "a" });
      expect(() => linkEntities(a.id, a.id)).toThrow(/cannot be linked to itself/);
    });

    it("rejects an unknown entity id", () => {
      const a = createEntity({ name: "a" });
      expect(() => linkEntities(a.id, 999999)).toThrow(/Unknown calendar entity/);
    });

    it("lists links matching either endpoint", () => {
      const a = createEntity({ name: "a" });
      const b = createEntity({ name: "b" });
      linkEntities(a.id, b.id);
      expect(listLinks(a.id).length).toBe(1);
      expect(listLinks(b.id).length).toBe(1);
    });

    it("unlinks, returning whether a row was removed", () => {
      const a = createEntity({ name: "a" });
      const b = createEntity({ name: "b" });
      linkEntities(a.id, b.id);
      expect(unlinkEntities(a.id, b.id)).toBe(true);
      expect(unlinkEntities(a.id, b.id)).toBe(false);
    });
  });

  describe("events", () => {
    it("normalizes an explicit offset to UTC Z form", () => {
      const a = createEntity({ name: "a" });
      const e = createEvent({
        entity_id: a.id, type: "downtime", title: "t",
        starts_at: "2026-08-01T10:00:00+05:30", ends_at: "2026-08-01T12:00:00+05:30",
      });
      expect(e.starts_at).toBe("2026-08-01T04:30:00.000Z");
      expect(e.ends_at).toBe("2026-08-01T06:30:00.000Z");
    });

    it("rejects a naive timestamp without timezone", () => {
      const a = createEntity({ name: "a" });
      expect(() =>
        createEvent({ entity_id: a.id, type: "downtime", title: "t", starts_at: "2026-08-01T10:00:00", ends_at: "2026-08-01T12:00:00" }),
      ).toThrow(/naive ISO timestamp/);
    });

    it("rejects ends_at <= starts_at on create", () => {
      const a = createEntity({ name: "a" });
      expect(() =>
        createEvent({ entity_id: a.id, type: "downtime", title: "t", starts_at: "2026-08-01T12:00:00Z", ends_at: "2026-08-01T10:00:00Z" }),
      ).toThrow(/must be after/);
    });

    it("rejects an unknown entity", () => {
      expect(() =>
        createEvent({ entity_id: 999999, type: "downtime", title: "t", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" }),
      ).toThrow(/Unknown calendar entity/);
    });

    it("re-validates the merged row on update", () => {
      const a = createEntity({ name: "a" });
      const e = createEvent({ entity_id: a.id, type: "downtime", title: "t", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" });
      expect(() => updateEvent(e.id, { ends_at: "2026-08-01T09:00:00Z" })).toThrow(/must be after/);
    });

    it("lists events using half-open overlap semantics", () => {
      const a = createEntity({ name: "a" });
      // Ends exactly at the window start -> excluded (half-open [from, to)).
      createEvent({ entity_id: a.id, type: "t", title: "adjacent-before", starts_at: "2026-08-01T08:00:00Z", ends_at: "2026-08-01T10:00:00Z" });
      // Straddles the window start -> included.
      const straddles = createEvent({ entity_id: a.id, type: "t", title: "straddles", starts_at: "2026-08-01T09:00:00Z", ends_at: "2026-08-01T11:00:00Z" });

      const found = listEvents({ from: "2026-08-01T10:00:00Z", to: "2026-08-01T12:00:00Z" });
      expect(found.map((e) => e.id)).toEqual([straddles.id]);
    });

    it("filters by entity_id and type", () => {
      const a = createEntity({ name: "a" });
      const b = createEntity({ name: "b" });
      createEvent({ entity_id: a.id, type: "downtime", title: "t1", starts_at: "2026-08-01T00:00:00Z", ends_at: "2026-08-01T01:00:00Z" });
      createEvent({ entity_id: b.id, type: "upgrade", title: "t2", starts_at: "2026-08-01T00:00:00Z", ends_at: "2026-08-01T01:00:00Z" });

      expect(listEvents({ entity_id: a.id }).length).toBe(1);
      expect(listEvents({ type: "upgrade" }).length).toBe(1);
    });

    it("orders results by starts_at", () => {
      const a = createEntity({ name: "a" });
      const e2 = createEvent({ entity_id: a.id, type: "t", title: "later", starts_at: "2026-08-02T00:00:00Z", ends_at: "2026-08-02T01:00:00Z" });
      const e1 = createEvent({ entity_id: a.id, type: "t", title: "earlier", starts_at: "2026-08-01T00:00:00Z", ends_at: "2026-08-01T01:00:00Z" });

      expect(listEvents().map((e) => e.id)).toEqual([e1.id, e2.id]);
    });

    it("deletes idempotently", () => {
      const a = createEntity({ name: "a" });
      const e = createEvent({ entity_id: a.id, type: "t", title: "x", starts_at: "2026-08-01T00:00:00Z", ends_at: "2026-08-01T01:00:00Z" });
      expect(deleteEvent(e.id)).toBe(true);
      expect(deleteEvent(e.id)).toBe(false);
      expect(getEvent(e.id)).toBeNull();
    });
  });
});
