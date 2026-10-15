/**
 * M56 — write-side outbox instrumentation for calendar and journal modules.
 *
 * Pins the contract that the write routines in src/calendar/repository.ts and
 * src/journal/repository.ts append outbound ops to the outbox (the matching OpKind),
 * atomically with the write, and that echo suppression (spec 1.4) makes the
 * SAME routines skip the enqueue entirely when reached inside a remote-apply
 * scope (inRemoteApply() === true).
 *
 * Operations covered:
 *   - calendar.entity.upsert (createEntity, updateEntity, deleteEntity)
 *   - calendar.link.upsert   (linkEntities, unlinkEntities)
 *   - calendar.event.upsert  (createEvent, updateEvent, deleteEvent)
 *   - journal.meta.upsert    (upsertJournalMeta, markUpgradeApplied)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import {
  createEntity,
  updateEntity,
  deleteEntity,
  linkEntities,
  unlinkEntities,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../../src/calendar/repository.js";
import {
  upsertJournalMeta,
  markUpgradeApplied,
  journalMetaForFile,
} from "../../src/journal/repository.js";
import { pendingOps, pendingCount } from "../../src/storage/outbox.js";
import { runInApplyScope, inRemoteApply } from "../../src/storage/apply.js";
import { getMachineId } from "../../src/identity/machine.js";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-cal-jrn-outbox-"));
const dbPath = join(TEST_DATA_DIR, "test.db");

function pending() {
  return pendingOps(getDatabase());
}

function findOps(kind: string) {
  return pending().filter((o) => o.op.kind === kind);
}

describe("calendar and journal write-routine outbox instrumentation (M56)", () => {
  beforeEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    createDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  describe("calendar entities", () => {
    it("createEntity appends calendar.entity.upsert op with null base_version and deleted: false", () => {
      const entity = createEntity({
        name: "Alice",
        kind: "person",
        notes: "Key contact",
        timezone: "America/New_York",
      });

      expect(pendingCount(getDatabase())).toBe(1);
      const ops = findOps("calendar.entity.upsert");
      expect(ops).toHaveLength(1);
      const op = ops[0].op;
      expect(op.gid).toBe(entity.gid);
      expect(op.origin).toBe(getMachineId());
      expect(op.base_version).toBeNull();
      expect(op.payload).toEqual({
        name: "Alice",
        kind: "person",
        notes: "Key contact",
        timezone: "America/New_York",
        active: true,
        deleted: false,
      });
    });

    it("updateEntity appends calendar.entity.upsert op with base_version: 0", () => {
      const entity = createEntity({ name: "Bob", kind: "client" });
      updateEntity(entity.id, { name: "Robert", notes: "Updated" });

      expect(pendingCount(getDatabase())).toBe(2);
      const ops = findOps("calendar.entity.upsert");
      expect(ops).toHaveLength(2);
      const updateOp = ops[1].op;
      expect(updateOp.gid).toBe(entity.gid);
      expect(updateOp.base_version).toBe(0);
      expect(updateOp.payload).toMatchObject({
        name: "Robert",
        kind: "client",
        notes: "Updated",
        active: true,
        deleted: false,
      });
    });

    it("deleteEntity appends calendar.entity.upsert op with deleted: true tombstone", () => {
      const entity = createEntity({ name: "Charlie" });
      deleteEntity(entity.id);

      expect(pendingCount(getDatabase())).toBe(2);
      const ops = findOps("calendar.entity.upsert");
      expect(ops).toHaveLength(2);
      const deleteOp = ops[1].op;
      expect(deleteOp.gid).toBe(entity.gid);
      expect(deleteOp.base_version).toBe(0);
      expect(deleteOp.payload).toMatchObject({
        name: "Charlie",
        deleted: true,
      });
    });
  });

  describe("calendar links", () => {
    it("linkEntities appends calendar.link.upsert with base_version: null for new link", () => {
      const a = createEntity({ name: "Entity A" });
      const b = createEntity({ name: "Entity B" });
      const link = linkEntities(a.id, b.id, "collaborates");

      expect(pendingCount(getDatabase())).toBe(3); // 2 entities + 1 link
      const ops = findOps("calendar.link.upsert");
      expect(ops).toHaveLength(1);
      const op = ops[0].op;
      expect(op.gid).toBe(link.gid);
      expect(op.base_version).toBeNull();
      expect(op.payload).toEqual({
        from_entity_id: a.id,
        to_entity_id: b.id,
        label: "collaborates",
        deleted: false,
      });
    });

    it("linkEntities appends calendar.link.upsert with base_version: 0 when updating existing link", () => {
      const a = createEntity({ name: "Entity C" });
      const b = createEntity({ name: "Entity D" });
      linkEntities(a.id, b.id, "friend");
      linkEntities(a.id, b.id, "partner");

      const ops = findOps("calendar.link.upsert");
      expect(ops).toHaveLength(2);
      const secondOp = ops[1].op;
      expect(secondOp.base_version).toBe(0);
      expect(secondOp.payload).toEqual({
        from_entity_id: a.id,
        to_entity_id: b.id,
        label: "partner",
        deleted: false,
      });
    });

    it("unlinkEntities appends calendar.link.upsert tombstone when link existed", () => {
      const a = createEntity({ name: "Entity E" });
      const b = createEntity({ name: "Entity F" });
      const link = linkEntities(a.id, b.id, "works-with");
      const unlinked = unlinkEntities(a.id, b.id);

      expect(unlinked).toBe(true);
      const ops = findOps("calendar.link.upsert");
      expect(ops).toHaveLength(2);
      const unlinkOp = ops[1].op;
      expect(unlinkOp.gid).toBe(link.gid);
      expect(unlinkOp.base_version).toBe(0);
      expect(unlinkOp.payload).toEqual({
        from_entity_id: a.id,
        to_entity_id: b.id,
        label: "works-with",
        deleted: true,
      });
    });

    it("unlinkEntities enqueues nothing if link did not exist", () => {
      const a = createEntity({ name: "Entity G" });
      const b = createEntity({ name: "Entity H" });
      const initialCount = pendingCount(getDatabase()); // 2 entity creates

      const unlinked = unlinkEntities(a.id, b.id);
      expect(unlinked).toBe(false);
      expect(pendingCount(getDatabase())).toBe(initialCount);
      expect(findOps("calendar.link.upsert")).toHaveLength(0);
    });
  });

  describe("calendar events", () => {
    it("createEvent appends calendar.event.upsert with null base_version and deleted: false", () => {
      const entity = createEntity({ name: "Team" });
      const event = createEvent({
        entity_id: entity.id,
        type: "meeting",
        title: "Sprint Planning",
        starts_at: "2026-10-15T10:00:00Z",
        ends_at: "2026-10-15T11:00:00Z",
        notes: "Discuss Q4 goals",
      });

      const ops = findOps("calendar.event.upsert");
      expect(ops).toHaveLength(1);
      const op = ops[0].op;
      expect(op.gid).toBe(event.gid);
      expect(op.base_version).toBeNull();
      expect(op.payload).toEqual({
        entity_id: entity.id,
        type: "meeting",
        title: "Sprint Planning",
        notes: "Discuss Q4 goals",
        starts_at: "2026-10-15T10:00:00.000Z",
        ends_at: "2026-10-15T11:00:00.000Z",
        original_timezone: null,
        source: null,
        deleted: false,
      });
    });

    it("updateEvent appends calendar.event.upsert with base_version: 0", () => {
      const entity = createEntity({ name: "Team 2" });
      const event = createEvent({
        entity_id: entity.id,
        type: "call",
        title: "Client Sync",
        starts_at: "2026-10-15T14:00:00Z",
        ends_at: "2026-10-15T14:30:00Z",
      });
      updateEvent(event.id, { title: "Client Review" });

      const ops = findOps("calendar.event.upsert");
      expect(ops).toHaveLength(2);
      const updateOp = ops[1].op;
      expect(updateOp.gid).toBe(event.gid);
      expect(updateOp.base_version).toBe(0);
      expect(updateOp.payload).toMatchObject({
        title: "Client Review",
        deleted: false,
      });
    });

    it("deleteEvent appends calendar.event.upsert tombstone when event existed", () => {
      const entity = createEntity({ name: "Team 3" });
      const event = createEvent({
        entity_id: entity.id,
        type: "workshop",
        title: "Antigravity Architecture",
        starts_at: "2026-10-16T09:00:00Z",
        ends_at: "2026-10-16T12:00:00Z",
      });
      const deleted = deleteEvent(event.id);
      expect(deleted).toBe(true);

      const ops = findOps("calendar.event.upsert");
      expect(ops).toHaveLength(2);
      const deleteOp = ops[1].op;
      expect(deleteOp.gid).toBe(event.gid);
      expect(deleteOp.base_version).toBe(0);
      expect(deleteOp.payload).toMatchObject({
        title: "Antigravity Architecture",
        deleted: true,
      });
    });

    it("deleteEvent enqueues nothing if event did not exist", () => {
      const initialCount = pendingCount(getDatabase());
      const deleted = deleteEvent(99999);
      expect(deleted).toBe(false);
      expect(pendingCount(getDatabase())).toBe(initialCount);
    });
  });

  describe("journal meta", () => {
    // Seed a minimal project & file record for foreign keys
    function seedFileAndProject(fileId: number = 42, projectId: number = 10) {
      const db = getDatabase();
      db.prepare(`INSERT OR IGNORE INTO projects (id, name, slug, path) VALUES (?, ?, ?, ?)`).run(
        projectId,
        "Test Project",
        "test-project",
        "/tmp/project",
      );
      db.prepare(
        `INSERT OR IGNORE INTO files (id, path, title, project_id, storage_type, content_hash)
         VALUES (?, ?, ?, ?, 'local', ?)`,
      ).run(fileId, `journal/task-${fileId}.md`, `Task ${fileId}`, projectId, "hash123");
    }

    it("upsertJournalMeta appends journal.meta.upsert with base_version: null for new journal meta", () => {
      seedFileAndProject(42, 10);
      const initialCount = pendingCount(getDatabase());

      upsertJournalMeta({
        file_id: 42,
        project_id: 10,
        task_slug: "task-1",
        status_latest: "in_progress",
        started_at: "2026-10-15T08:00:00.000Z",
        last_active_at: "2026-10-15T09:00:00.000Z",
        touched_files: ["src/index.ts"],
        raw_sources: ["prompt-1"],
        git_refs: [{ ref_type: "ticket", ref_value: "PROJ-101" }],
      });

      expect(pendingCount(getDatabase())).toBe(initialCount + 1);
      const ops = findOps("journal.meta.upsert");
      expect(ops).toHaveLength(1);
      const op = ops[0].op;
      const expectedGid = `42@${getMachineId()}`;
      expect(op.gid).toBe(expectedGid);
      expect(op.origin).toBe(getMachineId());
      expect(op.base_version).toBeNull();
      expect(op.payload).toEqual({
        file_id: 42,
        project_id: 10,
        task_slug: "task-1",
        status_latest: "in_progress",
        started_at: "2026-10-15T08:00:00.000Z",
        last_active_at: "2026-10-15T09:00:00.000Z",
        touched_files: ["src/index.ts"],
        raw_sources: ["prompt-1"],
        git_refs: [{ ref_type: "ticket", ref_value: "PROJ-101" }],
      });
    });

    it("upsertJournalMeta appends journal.meta.upsert with base_version: 0 when updating existing journal meta", () => {
      seedFileAndProject(43, 10);
      upsertJournalMeta({
        file_id: 43,
        project_id: 10,
        task_slug: "task-2",
        status_latest: "in_progress",
        started_at: "2026-10-15T08:00:00.000Z",
        last_active_at: "2026-10-15T09:00:00.000Z",
        touched_files: ["src/index.ts"],
        raw_sources: [],
        git_refs: [],
      });

      upsertJournalMeta({
        file_id: 43,
        project_id: 10,
        task_slug: "task-2",
        status_latest: "done",
        started_at: "2026-10-15T08:00:00.000Z",
        last_active_at: "2026-10-15T10:00:00.000Z",
        touched_files: ["src/index.ts", "src/util.ts"],
        raw_sources: [],
        git_refs: [],
      });

      const ops = findOps("journal.meta.upsert");
      expect(ops).toHaveLength(2);
      const secondOp = ops[1].op;
      expect(secondOp.base_version).toBe(0);
      expect(secondOp.payload).toMatchObject({
        file_id: 43,
        status_latest: "done",
        touched_files: ["src/index.ts", "src/util.ts"],
      });
    });

    it("markUpgradeApplied appends journal.meta.upsert with updated status_latest and base_version: 0", () => {
      seedFileAndProject(44, 10);
      upsertJournalMeta({
        file_id: 44,
        project_id: 10,
        task_slug: "task-3",
        status_latest: "pending",
        started_at: "2026-10-15T08:00:00.000Z",
        last_active_at: "2026-10-15T09:00:00.000Z",
        touched_files: [],
        raw_sources: [],
        git_refs: [{ ref_type: "commit", ref_value: "abc1234" }],
      });

      markUpgradeApplied(44, "upgraded");

      const meta = journalMetaForFile(44);
      expect(meta?.status_latest).toBe("upgraded");

      const ops = findOps("journal.meta.upsert");
      expect(ops).toHaveLength(2);
      const upgradeOp = ops[1].op;
      expect(upgradeOp.base_version).toBe(0);
      expect(upgradeOp.payload).toMatchObject({
        file_id: 44,
        status_latest: "upgraded",
        git_refs: [{ ref_type: "commit", ref_value: "abc1234" }],
      });
    });

    it("markUpgradeApplied does nothing and enqueues nothing if file_id does not exist", () => {
      const initialCount = pendingCount(getDatabase());
      markUpgradeApplied(99999, "upgraded");
      expect(pendingCount(getDatabase())).toBe(initialCount);
    });
  });

  describe("echo suppression (spec 1.4): no enqueue while inRemoteApply()", () => {
    it("calendar write routines persist to DB but enqueue NO ops inside a remote-apply scope", async () => {
      let sawRemote = false;
      let entityId: number;
      let eventId: number;

      await runInApplyScope(async () => {
        sawRemote = inRemoteApply();
        const a = createEntity({ name: "Remote Entity A" });
        const b = createEntity({ name: "Remote Entity B" });
        entityId = a.id;
        updateEntity(a.id, { notes: "remote notes" });
        linkEntities(a.id, b.id, "linked-remotely");
        unlinkEntities(a.id, b.id);

        const ev = createEvent({
          entity_id: a.id,
          type: "call",
          title: "Remote Call",
          starts_at: "2026-10-15T15:00:00Z",
          ends_at: "2026-10-15T16:00:00Z",
        });
        eventId = ev.id;
        updateEvent(ev.id, { title: "Remote Call Updated" });
        deleteEvent(ev.id);
        deleteEntity(b.id);
      });

      expect(sawRemote).toBe(true);
      expect(inRemoteApply()).toBe(false);

      // Database mutations succeeded
      const db = getDatabase();
      const entity = db.prepare("SELECT * FROM calendar_entities WHERE id = ?").get(entityId) as
        | { notes: string }
        | undefined;
      expect(entity?.notes).toBe("remote notes");

      // But zero outbox ops were enqueued!
      expect(pendingCount(db)).toBe(0);
    });

    it("journal write routines persist to DB but enqueue NO ops inside a remote-apply scope", async () => {
      const db = getDatabase();
      db.prepare(`INSERT OR IGNORE INTO projects (id, name, slug, path) VALUES (?, ?, ?, ?)`).run(
        20,
        "Remote Project",
        "remote-project",
        "/tmp/remote",
      );
      db.prepare(
        `INSERT OR IGNORE INTO files (id, path, title, project_id, storage_type, content_hash)
         VALUES (?, ?, ?, ?, 'local', ?)`,
      ).run(50, "journal/remote.md", "Remote Journal", 20, "hash50");

      let sawRemote = false;
      await runInApplyScope(async () => {
        sawRemote = inRemoteApply();
        upsertJournalMeta({
          file_id: 50,
          project_id: 20,
          task_slug: "remote-task",
          status_latest: "remote_status",
          started_at: "2026-10-15T08:00:00.000Z",
          last_active_at: "2026-10-15T09:00:00.000Z",
          touched_files: ["foo.ts"],
          raw_sources: [],
          git_refs: [],
        });
        markUpgradeApplied(50, "remotely_upgraded");
      });

      expect(sawRemote).toBe(true);
      expect(inRemoteApply()).toBe(false);

      // Changes persisted to database
      const meta = journalMetaForFile(50);
      expect(meta?.status_latest).toBe("remotely_upgraded");

      // Zero outbox ops enqueued
      expect(pendingCount(db)).toBe(0);
    });
  });
});
