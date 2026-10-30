/**
 * M58 — Complete applyRemoteOp logic and echo suppression.
 *
 * Verifies that:
 * 1. Every OpKind is properly dispatched and applied to the local store
 *    (both database records and filesystem changes where applicable).
 * 2. Every mutation executed during applyRemoteOp runs inside applyScope
 *    (inRemoteApply() === true), so ZERO outbound echo ops are enqueued
 *    to the outbox.
 * 3. Op validation fails closed on malformed ops before entering the scope.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { closeAllFileWatchers, createFileWatcher, type WatcherEvent } from "../../src/watcher/index.js";
import { applyRemoteOp } from "../../src/storage/apply.js";
import { UnappliableOpError } from "../../src/storage/errors.js";
import { resetDataDirCache } from "../../src/util/paths.js";
import { pendingCount, pendingOps } from "../../src/storage/outbox.js";
import type { Op } from "../../src/storage/op.js";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-apply-test-"));
const TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");

describe("applyRemoteOp (M58)", () => {
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.KONTEXTA_DATA_DIR;
    process.env.KONTEXTA_DATA_DIR = TEST_DATA_DIR;
    resetDataDirCache();
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });
    createDatabase(TEST_DB_PATH);
  });

  afterEach(async () => {
    // M59 tests spin up real chokidar watchers — make sure none outlive the
    // test DB (a stray event after closeDatabase would log "Database not
    // initialized" noise and race the next beforeEach).
    await closeAllFileWatchers();
    closeDatabase();
    if (prevDataDir === undefined) delete process.env.KONTEXTA_DATA_DIR;
    else process.env.KONTEXTA_DATA_DIR = prevDataDir;
    resetDataDirCache();
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("fails closed on malformed ops", async () => {
    const badGidOp = {
      gid: "not-a-gid",
      kind: "file.create",
      origin: "4f9e1a8b3c7d2e0f",
      base_version: null,
      payload: {},
      created_at: Date.now(),
    } as unknown as Op;

    await expect(applyRemoteOp(badGidOp)).rejects.toThrow("refusing to apply a malformed op");

    const badKindOp = {
      gid: "1@4f9e1a8b3c7d2e0f",
      kind: "unknown.kind",
      origin: "4f9e1a8b3c7d2e0f",
      base_version: null,
      payload: {},
      created_at: Date.now(),
    } as unknown as Op;

    await expect(applyRemoteOp(badKindOp)).rejects.toThrow("refusing to apply a malformed op");
  });

  describe("gid-only matching", () => {
    const create = (gid: string, path: string, content: string): Op => ({
      gid, kind: "file.create", origin: "remote0123456789", base_version: null,
      payload: { path, title: "T", content, storage_type: "local" }, created_at: Date.now(),
    });

    it("file.create for a new gid at an occupied path registers a path conflict and leaves the local file alone", async () => {
      const path = join(TEST_DATA_DIR, "knowledge", "todo.md");
      await applyRemoteOp(create("101@remote0123456789", path, "first"));
      await applyRemoteOp(create("102@remote0123456789", path, "second"));
      expect(readFileSync(path, "utf8")).toBe("first");
      const db = getDatabase();
      expect((db.prepare("SELECT gid FROM files WHERE path = ?").get(path) as { gid: string }).gid).toBe("101@remote0123456789");
      const rows = db.prepare("SELECT gid, conflict_kind FROM conflicts WHERE status = 'unresolved'").all();
      expect(rows).toEqual([{ gid: "102@remote0123456789", conflict_kind: "path" }]);
    });

    it("file.update never matches a row by path", async () => {
      const path = join(TEST_DATA_DIR, "knowledge", "u.md");
      await applyRemoteOp(create("103@remote0123456789", path, "first"));
      await applyRemoteOp({ gid: "104@remote0123456789", kind: "file.update", origin: "remote0123456789", base_version: 0, payload: { path, content: "hijack" }, created_at: Date.now() });
      expect(readFileSync(path, "utf8")).toBe("first");
      expect((getDatabase().prepare("SELECT gid FROM files WHERE path = ?").get(path) as { gid: string }).gid).toBe("103@remote0123456789");
    });

    it("file.delete with no gid match deletes nothing even if the path exists", async () => {
      const path = join(TEST_DATA_DIR, "knowledge", "d.md");
      await applyRemoteOp(create("105@remote0123456789", path, "keep me"));
      await applyRemoteOp({ gid: "106@remote0123456789", kind: "file.delete", origin: "remote0123456789", base_version: 0, payload: { path }, created_at: Date.now() });
      expect(existsSync(path)).toBe(true);
    });
  });

  describe("file ops", () => {
    it("file.create persists to DB + disk with remote gid and enqueues zero ops", async () => {
      const filePath = join(TEST_DATA_DIR, "knowledge", "remote-created.md");
      const remoteGid = "101@remote0123456789";

      const op: Op = {
        gid: remoteGid,
        kind: "file.create",
        origin: "remote0123456789",
        base_version: null,
        payload: {
          path: filePath,
          title: "Remote Created",
          content: "# Hello Remote World",
          storage_type: "local",
        },
        created_at: Date.now(),
      };

      await applyRemoteOp(op);

      // Disk assertions
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("# Hello Remote World");

      // DB assertions
      const db = getDatabase();
      const row = db.prepare("SELECT * FROM files WHERE gid = ?").get(remoteGid) as
        | { id: number; path: string; title: string; gid: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.path).toBe(filePath);
      expect(row!.title).toBe("Remote Created");
      expect(row!.gid).toBe(remoteGid);

      // FTS5 assertions
      const fts = db.prepare("SELECT * FROM fts_index WHERE rowid = ?").get(row!.id) as
        | { title: string; content: string }
        | undefined;
      expect(fts).toBeDefined();
      expect(fts!.content).toBe("# Hello Remote World");

      // Zero outbox ops (echo suppression)
      expect(pendingCount(db)).toBe(0);
    });

    it("file.update updates DB + disk and enqueues zero ops", async () => {
      const filePath = join(TEST_DATA_DIR, "knowledge", "file-to-update.md");
      const remoteGid = "102@remote0123456789";

      const createOp: Op = {
        gid: remoteGid,
        kind: "file.create",
        origin: "remote0123456789",
        base_version: null,
        payload: {
          path: filePath,
          title: "Initial Title",
          content: "Initial Content",
        },
        created_at: Date.now(),
      };
      await applyRemoteOp(createOp);

      const updateOp: Op = {
        gid: remoteGid,
        kind: "file.update",
        origin: "remote0123456789",
        base_version: 0,
        payload: {
          path: filePath,
          title: "Updated Title",
          content: "Updated Content",
        },
        created_at: Date.now() + 1000,
      };
      await applyRemoteOp(updateOp);

      expect(readFileSync(filePath, "utf8")).toBe("Updated Content");

      const db = getDatabase();
      const row = db.prepare("SELECT * FROM files WHERE gid = ?").get(remoteGid) as
        | { title: string; content_hash: string }
        | undefined;
      expect(row!.title).toBe("Updated Title");

      const fts = db.prepare("SELECT * FROM fts_index WHERE title = ?").get("Updated Title");
      expect(fts).toBeDefined();

      expect(pendingCount(db)).toBe(0);
    });

    it("file.move renames file on disk and updates DB path with zero ops enqueued", async () => {
      const fromPath = join(TEST_DATA_DIR, "knowledge", "before-move.md");
      const toPath = join(TEST_DATA_DIR, "knowledge", "after-move.md");
      const remoteGid = "103@remote0123456789";

      await applyRemoteOp({
        gid: remoteGid,
        kind: "file.create",
        origin: "remote0123456789",
        base_version: null,
        payload: { path: fromPath, title: "Moving File", content: "To be moved" },
        created_at: Date.now(),
      });

      expect(existsSync(fromPath)).toBe(true);

      await applyRemoteOp({
        gid: remoteGid,
        kind: "file.move",
        origin: "remote0123456789",
        base_version: 0,
        payload: { from: fromPath, to: toPath },
        created_at: Date.now() + 1000,
      });

      expect(existsSync(fromPath)).toBe(false);
      expect(existsSync(toPath)).toBe(true);

      const db = getDatabase();
      const row = db.prepare("SELECT path FROM files WHERE gid = ?").get(remoteGid) as
        | { path: string }
        | undefined;
      expect(row!.path).toBe(toPath);
      expect(pendingCount(db)).toBe(0);
    });

    it("file.delete removes file from disk and DB with zero ops enqueued", async () => {
      const filePath = join(TEST_DATA_DIR, "knowledge", "to-delete.md");
      const remoteGid = "104@remote0123456789";

      await applyRemoteOp({
        gid: remoteGid,
        kind: "file.create",
        origin: "remote0123456789",
        base_version: null,
        payload: { path: filePath, title: "Delete Me", content: "Gone soon" },
        created_at: Date.now(),
      });

      expect(existsSync(filePath)).toBe(true);

      await applyRemoteOp({
        gid: remoteGid,
        kind: "file.delete",
        origin: "remote0123456789",
        base_version: 0,
        payload: { path: filePath },
        created_at: Date.now() + 1000,
      });

      expect(existsSync(filePath)).toBe(false);

      const db = getDatabase();
      const row = db.prepare("SELECT id FROM files WHERE gid = ?").get(remoteGid);
      expect(row).toBeUndefined();
      expect(pendingCount(db)).toBe(0);
    });
  });

  describe("folder ops", () => {
    it("folder.create and folder.delete manage directories with zero ops enqueued", async () => {
      const folderPath = join(TEST_DATA_DIR, "knowledge", "subfolder");

      await applyRemoteOp({
        gid: "201@remote0123456789",
        kind: "folder.create",
        origin: "remote0123456789",
        base_version: null,
        payload: { path: folderPath },
        created_at: Date.now(),
      });

      expect(existsSync(folderPath)).toBe(true);

      await applyRemoteOp({
        gid: "202@remote0123456789",
        kind: "folder.delete",
        origin: "remote0123456789",
        base_version: 0,
        payload: { path: folderPath },
        created_at: Date.now() + 1000,
      });

      expect(existsSync(folderPath)).toBe(false);
      expect(pendingCount(getDatabase())).toBe(0);
    });
  });

  describe("metadata ops", () => {
    it("tag.add and tag.remove update file tags with zero ops enqueued", async () => {
      const filePath = join(TEST_DATA_DIR, "knowledge", "tagged.md");
      const remoteGid = "301@remote0123456789";

      await applyRemoteOp({
        gid: remoteGid,
        kind: "file.create",
        origin: "remote0123456789",
        base_version: null,
        payload: { path: filePath, title: "Tagged", content: "Content" },
        created_at: Date.now(),
      });

      await applyRemoteOp({
        gid: remoteGid,
        kind: "tag.add",
        origin: "remote0123456789",
        base_version: 0,
        payload: { tags: ["research", "backend"] },
        created_at: Date.now() + 500,
      });

      const db = getDatabase();
      const file = db.prepare("SELECT id FROM files WHERE gid = ?").get(remoteGid) as { id: number };
      const tags = db
        .prepare(
          "SELECT t.name FROM tags t JOIN file_tags ft ON t.id = ft.tag_id WHERE ft.file_id = ? ORDER BY t.name",
        )
        .all(file.id) as { name: string }[];
      expect(tags.map((t) => t.name)).toEqual(["backend", "research"]);

      await applyRemoteOp({
        gid: remoteGid,
        kind: "tag.remove",
        origin: "remote0123456789",
        base_version: 0,
        payload: { tags: ["research"] },
        created_at: Date.now() + 1000,
      });

      const remainingTags = db
        .prepare(
          "SELECT t.name FROM tags t JOIN file_tags ft ON t.id = ft.tag_id WHERE ft.file_id = ?",
        )
        .all(file.id) as { name: string }[];
      expect(remainingTags.map((t) => t.name)).toEqual(["backend"]);
      expect(pendingCount(db)).toBe(0);
    });

    it("favorite.set toggles favorite flag with zero ops enqueued", async () => {
      const filePath = join(TEST_DATA_DIR, "knowledge", "fav.md");
      const remoteGid = "302@remote0123456789";

      await applyRemoteOp({
        gid: remoteGid,
        kind: "file.create",
        origin: "remote0123456789",
        base_version: null,
        payload: { path: filePath, title: "Favorite", content: "Fav content" },
        created_at: Date.now(),
      });

      await applyRemoteOp({
        gid: remoteGid,
        kind: "favorite.set",
        origin: "remote0123456789",
        base_version: 0,
        payload: { favorite: true },
        created_at: Date.now() + 500,
      });

      const db = getDatabase();
      const file = db.prepare("SELECT id FROM files WHERE gid = ?").get(remoteGid) as { id: number };
      const fav = db.prepare("SELECT 1 FROM favorites WHERE file_id = ?").get(file.id);
      expect(fav).toBeDefined();

      await applyRemoteOp({
        gid: remoteGid,
        kind: "favorite.set",
        origin: "remote0123456789",
        base_version: 0,
        payload: { favorite: false },
        created_at: Date.now() + 1000,
      });

      const favAfter = db.prepare("SELECT 1 FROM favorites WHERE file_id = ?").get(file.id);
      expect(favAfter).toBeUndefined();
      expect(pendingCount(db)).toBe(0);
    });

    it("project.register and project.unregister update projects with zero ops enqueued", async () => {
      const projectGid = "401@remote0123456789";

      await applyRemoteOp({
        gid: projectGid,
        kind: "project.register",
        origin: "remote0123456789",
        base_version: null,
        payload: {
          name: "Remote Project",
          slug: "remote-project",
          path: join(TEST_DATA_DIR, "remote-proj"),
          description: "A remote project",
        },
        created_at: Date.now(),
      });

      const db = getDatabase();
      const project = db.prepare("SELECT * FROM projects WHERE gid = ?").get(projectGid) as
        | { id: number; name: string; slug: string }
        | undefined;
      expect(project).toBeDefined();
      expect(project!.name).toBe("Remote Project");

      await applyRemoteOp({
        gid: projectGid,
        kind: "project.unregister",
        origin: "remote0123456789",
        base_version: 0,
        payload: { slug: "remote-project" },
        created_at: Date.now() + 1000,
      });

      const gone = db.prepare("SELECT id FROM projects WHERE gid = ?").get(projectGid);
      expect(gone).toBeUndefined();
      expect(pendingCount(db)).toBe(0);
    });
  });

  describe("calendar ops", () => {
    it("calendar.entity.upsert creates, updates, and deletes entities with zero ops enqueued", async () => {
      const entityGid = "501@remote0123456789";

      await applyRemoteOp({
        gid: entityGid,
        kind: "calendar.entity.upsert",
        origin: "remote0123456789",
        base_version: null,
        payload: {
          name: "Remote Alice",
          kind: "person",
          notes: "Remote contact",
          timezone: "UTC",
          active: true,
          deleted: false,
        },
        created_at: Date.now(),
      });

      const db = getDatabase();
      const entity = db.prepare("SELECT * FROM calendar_entities WHERE gid = ?").get(entityGid) as
        | { id: number; name: string }
        | undefined;
      expect(entity).toBeDefined();
      expect(entity!.name).toBe("Remote Alice");

      // Update entity
      await applyRemoteOp({
        gid: entityGid,
        kind: "calendar.entity.upsert",
        origin: "remote0123456789",
        base_version: 0,
        payload: {
          name: "Remote Alicia",
          deleted: false,
        },
        created_at: Date.now() + 500,
      });

      const updated = db.prepare("SELECT name FROM calendar_entities WHERE gid = ?").get(entityGid) as {
        name: string;
      };
      expect(updated.name).toBe("Remote Alicia");

      // Tombstone deletion
      await applyRemoteOp({
        gid: entityGid,
        kind: "calendar.entity.upsert",
        origin: "remote0123456789",
        base_version: 0,
        payload: {
          name: "Remote Alicia",
          deleted: true,
        },
        created_at: Date.now() + 1000,
      });

      const deleted = db.prepare("SELECT id FROM calendar_entities WHERE gid = ?").get(entityGid);
      expect(deleted).toBeUndefined();
      expect(pendingCount(db)).toBe(0);
    });

    it("calendar.event.upsert and calendar.link.upsert function with zero ops enqueued", async () => {
      const entity1Gid = "502@remote0123456789";
      const entity2Gid = "503@remote0123456789";

      await applyRemoteOp({
        gid: entity1Gid,
        kind: "calendar.entity.upsert",
        origin: "remote0123456789",
        base_version: null,
        payload: { name: "Entity 1", deleted: false },
        created_at: Date.now(),
      });

      await applyRemoteOp({
        gid: entity2Gid,
        kind: "calendar.entity.upsert",
        origin: "remote0123456789",
        base_version: null,
        payload: { name: "Entity 2", deleted: false },
        created_at: Date.now(),
      });

      const db = getDatabase();
      expect(db.prepare("SELECT id FROM calendar_entities WHERE gid = ?").get(entity1Gid)).toBeDefined();
      expect(db.prepare("SELECT id FROM calendar_entities WHERE gid = ?").get(entity2Gid)).toBeDefined();

      // Link entities
      const linkGid = "601@remote0123456789";
      await applyRemoteOp({
        gid: linkGid,
        kind: "calendar.link.upsert",
        origin: "remote0123456789",
        base_version: null,
        payload: {
          from_entity_gid: entity1Gid,
          to_entity_gid: entity2Gid,
          label: "collaborator",
          deleted: false,
        },
        created_at: Date.now() + 500,
      });

      const link = db.prepare("SELECT * FROM calendar_links WHERE gid = ?").get(linkGid) as
        | { label: string }
        | undefined;
      expect(link).toBeDefined();
      expect(link!.label).toBe("collaborator");

      // Event upsert
      const eventGid = "701@remote0123456789";
      await applyRemoteOp({
        gid: eventGid,
        kind: "calendar.event.upsert",
        origin: "remote0123456789",
        base_version: null,
        payload: {
          entity_gid: entity1Gid,
          type: "meeting",
          title: "Architecture Sync",
          starts_at: "2026-10-15T14:00:00Z",
          ends_at: "2026-10-15T15:00:00Z",
          deleted: false,
        },
        created_at: Date.now() + 600,
      });

      const event = db.prepare("SELECT * FROM calendar_events WHERE gid = ?").get(eventGid) as
        | { title: string }
        | undefined;
      expect(event).toBeDefined();
      expect(event!.title).toBe("Architecture Sync");

      // Delete link and event
      await applyRemoteOp({
        gid: linkGid,
        kind: "calendar.link.upsert",
        origin: "remote0123456789",
        base_version: 0,
        payload: {
          from_entity_gid: entity1Gid,
          to_entity_gid: entity2Gid,
          deleted: true,
        },
        created_at: Date.now() + 1000,
      });

      const deletedLink = db.prepare("SELECT id FROM calendar_links WHERE gid = ?").get(linkGid);
      expect(deletedLink).toBeUndefined();

      await applyRemoteOp({
        gid: eventGid,
        kind: "calendar.event.upsert",
        origin: "remote0123456789",
        base_version: 0,
        payload: {
          entity_gid: entity1Gid,
          type: "meeting",
          title: "Architecture Sync",
          starts_at: "2026-10-15T14:00:00Z",
          ends_at: "2026-10-15T15:00:00Z",
          deleted: true,
        },
        created_at: Date.now() + 1100,
      });

      const deletedEvent = db.prepare("SELECT id FROM calendar_events WHERE gid = ?").get(eventGid);
      expect(deletedEvent).toBeUndefined();
      expect(pendingCount(db)).toBe(0);
    });
  });

  describe("journal ops", () => {
    it("journal.meta.upsert applies journal metadata with zero ops enqueued", async () => {
      const filePath = join(TEST_DATA_DIR, "knowledge", "journal-entry.md");
      const fileGid = "801@remote0123456789";

      await applyRemoteOp({
        gid: fileGid,
        kind: "file.create",
        origin: "remote0123456789",
        base_version: null,
        payload: { path: filePath, title: "Journal Entry", content: "Entry text" },
        created_at: Date.now(),
      });

      const db = getDatabase();
      const journalGid = fileGid;
      await applyRemoteOp({
        gid: journalGid,
        kind: "journal.meta.upsert",
        origin: "remote0123456789",
        base_version: null,
        payload: {
          task_slug: "task-apply-test",
          status_latest: "done",
          started_at: "2026-10-15T10:00:00Z",
          last_active_at: "2026-10-15T11:00:00Z",
          touched_files: ["src/storage/apply.ts"],
          raw_sources: ["test-run"],
          git_refs: [{ ref_type: "ticket", ref_value: "M58" }],
        },
        created_at: Date.now() + 500,
      });

      const meta = db.prepare("SELECT * FROM journal_meta WHERE gid = ?").get(journalGid) as
        | { task_slug: string; status_latest: string }
        | undefined;
      expect(meta).toBeDefined();
      expect(meta!.task_slug).toBe("task-apply-test");
      expect(meta!.status_latest).toBe("done");

      expect(pendingCount(db)).toBe(0);
    });
  });

  describe("watcher echo suppression (M59)", () => {
    async function waitFor(
      predicate: () => boolean,
      timeoutMs = 3000,
      intervalMs = 50,
    ): Promise<boolean> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return predicate();
    }

    it(
      "verifies zero outbox ops are enqueued after remote writes with active watcher",
      async () => {
        const events: WatcherEvent[] = [];
        const watcher = createFileWatcher([TEST_DATA_DIR], (e) => events.push(e));

        // Wait for watcher readiness
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 500);
          watcher.once("ready", () => {
            clearTimeout(t);
            resolve();
          });
        });

        const filePath = join(TEST_DATA_DIR, "knowledge", "echo-test.md");
        const remoteGid = "901@remote0123456789";

        // 1. Remote file.create
        await applyRemoteOp({
          gid: remoteGid,
          kind: "file.create",
          origin: "remote0123456789",
          base_version: null,
          payload: {
            path: filePath,
            title: "Echo Test",
            content: "# Suppressed Echo",
          },
          created_at: Date.now(),
        });

        // Await watcher event and stability delay (awaitWriteFinish: 300ms + 350ms buffer)
        const sawCreate = await waitFor(() => events.some((e) => e.path === filePath), 2500);
        expect(sawCreate).toBe(true);
        await new Promise((r) => setTimeout(r, 400));

        const db = getDatabase();
        expect(pendingCount(db), "file.create must not produce an echo op in outbox").toBe(0);

        // 2. Remote file.update
        events.length = 0;
        await applyRemoteOp({
          gid: remoteGid,
          kind: "file.update",
          origin: "remote0123456789",
          base_version: 0,
          payload: {
            path: filePath,
            title: "Echo Test Updated",
            content: "# Suppressed Echo - Updated Content",
          },
          created_at: Date.now() + 1000,
        });

        // Await watcher change event and stability delay
        const sawUpdate = await waitFor(() => events.some((e) => e.path === filePath && e.type === "change"), 2500);
        expect(sawUpdate).toBe(true);
        await new Promise((r) => setTimeout(r, 400));

        expect(pendingCount(db), "file.update must not produce an echo op in outbox").toBe(0);

        // 3. Remote file.move
        events.length = 0;
        const movedPath = join(TEST_DATA_DIR, "knowledge", "echo-moved.md");
        await applyRemoteOp({
          gid: remoteGid,
          kind: "file.move",
          origin: "remote0123456789",
          base_version: 1,
          payload: {
            from: filePath,
            to: movedPath,
          },
          created_at: Date.now() + 1500,
        });

        // Await watcher event on destination path and stability delay
        const sawMove = await waitFor(() => events.some((e) => e.path === movedPath), 2500);
        expect(sawMove).toBe(true);
        await new Promise((r) => setTimeout(r, 400));

        expect(pendingCount(db), "file.move must not produce an echo op in outbox").toBe(0);

        // 4. Remote file.delete
        events.length = 0;
        await applyRemoteOp({
          gid: remoteGid,
          kind: "file.delete",
          origin: "remote0123456789",
          base_version: 2,
          payload: {
            path: movedPath,
          },
          created_at: Date.now() + 2000,
        });

        // Await watcher unlink event and stability delay
        const sawDelete = await waitFor(() => events.some((e) => e.path === movedPath && e.type === "unlink"), 2500);
        expect(sawDelete).toBe(true);
        await new Promise((r) => setTimeout(r, 400));

        expect(pendingCount(db), "file.delete must not produce an echo op in outbox").toBe(0);

        await watcher.close();
      },
      15000,
    );

    it(
      "contrasts with direct local external write which DOES enqueue an outbox op",
      async () => {
        const events: WatcherEvent[] = [];
        const watcher = createFileWatcher([TEST_DATA_DIR], (e) => events.push(e));

        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 500);
          watcher.once("ready", () => {
            clearTimeout(t);
            resolve();
          });
        });

        const externalFile = join(TEST_DATA_DIR, "knowledge", "external.md");
        writeFileSync(externalFile, "# Externally created", "utf8");

        const sawAdd = await waitFor(() => events.some((e) => e.path === externalFile && e.type === "add"), 2500);
        expect(sawAdd).toBe(true);
        await new Promise((r) => setTimeout(r, 400));

        const db = getDatabase();
        expect(pendingCount(db), "external write MUST enqueue an outbox op").toBe(1);
        const ops = pendingOps(db);
        expect(ops[0].op.kind).toBe("file.create");
        expect((ops[0].op.payload as { path?: string }).path).toBe(externalFile);

        await watcher.close();
      },
      15000,
    );
  });

  describe("path safety and gid resolution", () => {
    const ORIGIN = "remote0123456789";
    let outsideDir: string;

    beforeEach(() => {
      outsideDir = mkdtempSync(join(tmpdir(), "kontexta-apply-outside-"));
    });

    afterEach(() => {
      rmSync(outsideDir, { recursive: true, force: true });
    });

    const op = (gid: string, kind: Op["kind"], payload: unknown): Op => ({
      gid,
      kind,
      origin: ORIGIN,
      base_version: null,
      payload,
      created_at: Date.now(),
    });

    it("rejects an absolute path outside the data dir and writes nothing", async () => {
      const target = join(outsideDir, "evil.md");
      await expect(
        applyRemoteOp(op("1001@" + ORIGIN, "file.create", { path: target, title: "Evil", content: "x" })),
      ).rejects.toBeInstanceOf(UnappliableOpError);
      expect(existsSync(target)).toBe(false);
    });

    it("file.delete and folder.delete aimed outside the data dir leave a sentinel intact", async () => {
      const sentinel = join(outsideDir, "sentinel.txt");
      writeFileSync(sentinel, "keep me", "utf8");

      await expect(
        applyRemoteOp(op("1002@" + ORIGIN, "file.delete", { path: sentinel })),
      ).rejects.toBeInstanceOf(UnappliableOpError);
      await expect(
        applyRemoteOp(op("1003@" + ORIGIN, "folder.delete", { path: outsideDir })),
      ).rejects.toBeInstanceOf(UnappliableOpError);

      expect(readFileSync(sentinel, "utf8")).toBe("keep me");
    });

    it("rejects '../' traversal in rel_path", async () => {
      await expect(
        applyRemoteOp(
          op("1004@" + ORIGIN, "file.create", {
            path: "/origin/data/knowledge/x.md",
            rel_path: "../escaped.md",
            content: "x",
          }),
        ),
      ).rejects.toBeInstanceOf(UnappliableOpError);
      expect(existsSync(join(TEST_DATA_DIR, "..", "escaped.md"))).toBe(false);
    });

    it("rejects an absolute path outside the data dir even if it contains /knowledge/", async () => {
      await expect(
        applyRemoteOp({
          gid: "107@remote0123456789", kind: "file.create", origin: "remote0123456789", base_version: null,
          payload: { path: "/Users/someone/.kontexta/knowledge/legacy/note.md", title: "n", content: "x", storage_type: "local" },
          created_at: Date.now(),
        } as Op),
      ).rejects.toThrow(/outside the data directory/);
    });

    it("prefers rel_path over the origin's absolute path", async () => {
      const gid = "1006@" + ORIGIN;
      await applyRemoteOp(
        op(gid, "file.create", {
          path: join(outsideDir, "ignored.md"),
          rel_path: "knowledge/from-rel.md",
          title: "Rel",
          content: "# Rel",
        }),
      );
      expect(readFileSync(join(TEST_DATA_DIR, "knowledge", "from-rel.md"), "utf8")).toBe("# Rel");
      expect(existsSync(join(outsideDir, "ignored.md"))).toBe(false);
    });

    it("refuses folder.delete of the data dir itself", async () => {
      await expect(
        applyRemoteOp(op("1007@" + ORIGIN, "folder.delete", { path: TEST_DATA_DIR })),
      ).rejects.toBeInstanceOf(UnappliableOpError);
      await expect(
        applyRemoteOp(op("1008@" + ORIGIN, "folder.delete", { path: "/x", rel_path: "." })),
      ).rejects.toBeInstanceOf(UnappliableOpError);
      expect(existsSync(join(TEST_DATA_DIR, "knowledge"))).toBe(true);
    });

    it("tag.add, favorite.set and journal.meta.upsert for an unknown gid throw and leave a same-id local file untouched", async () => {
      const db = getDatabase();
      const localPath = join(TEST_DATA_DIR, "knowledge", "local.md");
      writeFileSync(localPath, "local", "utf8");
      const info = db
        .prepare("INSERT INTO files (path, title, storage_type, content_hash, gid) VALUES (?, 'Local', 'local', 'h', ?)")
        .run(localPath, "9@localmachine0000");
      const localId = Number(info.lastInsertRowid);
      const unknownGid = `${localId}@${ORIGIN}`;

      await expect(
        applyRemoteOp(op(unknownGid, "tag.add", { file_id: localId, tags: ["leak"] })),
      ).rejects.toBeInstanceOf(UnappliableOpError);
      await expect(
        applyRemoteOp(op(unknownGid, "favorite.set", { file_id: localId, favorite: true })),
      ).rejects.toBeInstanceOf(UnappliableOpError);
      await expect(
        applyRemoteOp(
          op(unknownGid, "journal.meta.upsert", {
            file_id: localId,
            task_slug: "t",
            started_at: "2026-10-15T10:00:00Z",
            last_active_at: "2026-10-15T11:00:00Z",
          }),
        ),
      ).rejects.toBeInstanceOf(UnappliableOpError);

      expect(db.prepare("SELECT 1 FROM file_tags WHERE file_id = ?").get(localId)).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM favorites WHERE file_id = ?").get(localId)).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM journal_meta WHERE file_id = ?").get(localId)).toBeUndefined();
    });

    it("calendar.event.upsert resolves its entity by entity_gid, not a numeric id", async () => {
      const db = getDatabase();
      const entityGid = "1101@" + ORIGIN;
      await applyRemoteOp(op(entityGid, "calendar.entity.upsert", { name: "Gid Entity", deleted: false }));
      const entity = db.prepare("SELECT id FROM calendar_entities WHERE gid = ?").get(entityGid) as { id: number };

      const eventGid = "1102@" + ORIGIN;
      await applyRemoteOp(
        op(eventGid, "calendar.event.upsert", {
          entity_gid: entityGid,
          entity_id: entity.id + 1000,
          type: "meeting",
          title: "By Gid",
          starts_at: "2026-10-15T14:00:00Z",
          ends_at: "2026-10-15T15:00:00Z",
          deleted: false,
        }),
      );
      const ev = db.prepare("SELECT entity_id FROM calendar_events WHERE gid = ?").get(eventGid) as { entity_id: number };
      expect(ev.entity_id).toBe(entity.id);

      await expect(
        applyRemoteOp(
          op("1103@" + ORIGIN, "calendar.event.upsert", {
            entity_gid: "9999@" + ORIGIN,
            type: "meeting",
            title: "Orphan",
            starts_at: "2026-10-15T14:00:00Z",
            ends_at: "2026-10-15T15:00:00Z",
            deleted: false,
          }),
        ),
      ).rejects.toBeInstanceOf(UnappliableOpError);
    });
  });
});
