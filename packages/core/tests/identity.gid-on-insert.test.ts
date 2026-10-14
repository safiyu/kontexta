/**
 * Identity — GID assignment on insert (Phase 2).
 *
 * Asserts that every syncable write routine stamps its record with a `gid`
 * of the form `<id>@<machine_id>` at INSERT time, so that the migration-013
 * backfill is a no-op for all records created after 013. Covers the write
 * paths listed in the plan:
 *
 *   - files.createFile                          (files/index.ts)
 *   - metadata.registerProject                  (metadata/index.ts)
 *   - metadata.addTags                          (metadata/index.ts)
 *   - calendar.createEntity / createEvent / linkEntities (calendar/repository.ts)
 *   - journal.upsertJournalMeta                 (journal/repository.ts)
 *   - watcher on-disk file discovery            (watcher/index.ts)
 *
 * This is a RED test at the milestone it is written in (M37): the write
 * routines are instrumented to assign `gid` in the follow-up milestones
 * (M38–M42), which turn it GREEN.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Test infrastructure -------------------------------------------------
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";

// --- Identity (M35) ------------------------------------------------------
import { getMachineId } from "../src/identity/machine.js";
import { parseGid, isLocalGid, type GidParts } from "../src/identity/gid.js";

// --- SUT: write routines that must assign a gid ---------------------------
import { createFile } from "../src/files/index.js";
import { addTags, registerProject } from "../src/metadata/index.js";
import { createEntity, createEvent, linkEntities } from "../src/calendar/index.js";
import { upsertJournalMeta } from "../src/journal/index.js";
import { createFileWatcher } from "../src/watcher/index.js";

type Row = Record<string, unknown>;

function one(sql: string, ...params: unknown[]): Row {
  const r = getDatabase().prepare(sql).get(...params) as Row | undefined;
  if (!r) throw new Error(`row not found: ${sql}`);
  return r;
}

// Captured per-test in beforeEach (after createDatabase) — each test opens a
// fresh DB whose migration-013 run seeds its OWN random machine_id, so a
// module-load constant would be stale for every test after the first.
let MACHINE_ID = "";
const MACHINE_ID_RE = /^[0-9a-f]{16}$/;

/**
 * Assert that a record's `gid` is exactly `<id>@<MACHINE_ID>` where `<id>`
 * is the record's own primary-key column. Returns the parsed parts for
 * further assertions.
 */
function expectGidMatchesPk(table: string, pkColumn: string, row: Row): GidParts {
  const gid = row["gid"];
  expect(gid, `${table} row must carry a gid (not NULL)`).toBeTruthy();
  expect(typeof gid, "gid must be a string").toBe("string");
  expect(isLocalGid(gid as string), `gid must be local to this machine: ${gid}`).toBe(true);

  const parts = parseGid(gid as string);
  expect(parts, `gid must parse: ${gid}`).not.toBeNull();
  const p = parts as GidParts;

  // The machine part must be the real, stable 16-hex machine id.
  expect(p.machineId, "machine part of gid must equal settings.machine_id").toBe(MACHINE_ID);
  expect(p.machineId).toMatch(MACHINE_ID_RE);

  // The local part must be the record's own integer PK.
  const pk = row[pkColumn];
  expect(pk, `${table}.${pkColumn} must be set`).toBeTruthy();
  expect(p.localId, `local part of gid must equal ${table}.${pkColumn}`).toBe(Number(pk));

  return p;
}

describe("identity: gid is assigned on insert", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kxta-gid-insert-"));
  const dbPath = path.join(dataDir, "test.db");
  const knowledgeDir = path.join(dataDir, "knowledge");

  beforeEach(() => {
    fs.mkdirSync(knowledgeDir, { recursive: true });
    createDatabase(dbPath); // auto-runs migrations (incl. 013: clients + gid columns)
    MACHINE_ID = getMachineId(); // this test's fresh vault identity
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("files: createFile assigns gid = <id>@<machine_id>", async () => {
    const created = await createFile({
      title: "Gid On Insert",
      content: "# on-insert file\n\nhello",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
      tags: ["test"],
    });
    expect(created.id).toBeGreaterThan(0);

    const row = one("SELECT id, gid FROM files WHERE id = ?", created.id);
    expectGidMatchesPk("files", "id", row);
    expect(row["gid"]).toBe(`${created.id}@${MACHINE_ID}`);
  });

  it("metadata: registerProject assigns gid = <id>@<machine_id>", () => {
    const projPath = path.join(dataDir, "proj");
    fs.mkdirSync(projPath, { recursive: true });

    const reg = registerProject("Gid Project", projPath);
    expect(reg.id).toBeGreaterThan(0);

    const row = one("SELECT id, gid FROM projects WHERE id = ?", reg.id);
    expectGidMatchesPk("projects", "id", row);
  });

  it("metadata: addTags assigns gid = <id>@<machine_id>", async () => {
    const file = await createFile({
      title: "Gid On Insert Tags",
      content: "content",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });

    // A brand-new tag (never previously registered) must be stamped on insert.
    addTags(file.id, ["fresh-tag-a"]);

    const row = one("SELECT id, gid, name FROM tags WHERE name = 'fresh-tag-a'");
    expect(row["id"]).toBeTruthy();
    expectGidMatchesPk("tags", "id", row);
  });

  it("calendar: entity, event, and link inserts assign gid = <id>@<machine_id>", () => {
    const entity = createEntity({ name: "GID Person", kind: "person" });
    expect(entity.id).toBeGreaterThan(0);
    expectGidMatchesPk(
      "calendar_entities",
      "id",
      one("SELECT id, gid FROM calendar_entities WHERE id = ?", entity.id),
    );

    const event = createEvent({
      entity_id: entity.id,
      type: "meeting",
      title: "GID Event",
      starts_at: "2026-10-14T09:00:00Z",
      ends_at: "2026-10-14T09:30:00Z",
    });
    expect(event.id).toBeGreaterThan(0);
    expectGidMatchesPk(
      "calendar_events",
      "id",
      one("SELECT id, gid FROM calendar_events WHERE id = ?", event.id),
    );

    const second = createEntity({ name: "GID Person 2", kind: "person" });
    const link = linkEntities(entity.id, second.id, "collaborates");
    expect(link.id).toBeGreaterThan(0);
    expectGidMatchesPk(
      "calendar_links",
      "id",
      one("SELECT id, gid FROM calendar_links WHERE id = ?", link.id),
    );
  });

  it("journal: upsertJournalMeta assigns gid = <file_id>@<machine_id>", async () => {
    const file = await createFile({
      title: "Gid Journal Meta",
      content: "journal target",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });

    const projPath = path.join(dataDir, "journal-proj");
    fs.mkdirSync(projPath, { recursive: true });
    const proj = registerProject("Gid Journal Proj", projPath);

    upsertJournalMeta({
      file_id: file.id,
      project_id: proj.id,
      task_slug: "gid-task",
      started_at: "2026-10-14T09:00:00Z",
      last_active_at: "2026-10-14T10:00:00Z",
      touched_files: [],
      raw_sources: [],
      git_refs: [],
    });

    // journal_meta is keyed by file_id (its PK); the 013 backfill also uses
    // file_id, so the on-insert gid must match it.
    const row = one("SELECT file_id, gid FROM journal_meta WHERE file_id = ?", file.id);
    expectGidMatchesPk("journal_meta", "file_id", row);
  });

  it("watcher: a file dropped into the knowledge dir gets gid = <id>@<machine_id>", async () => {
    const events: unknown[] = [];
    const watcher: ReturnType<typeof createFileWatcher> = createFileWatcher([dataDir], (e) => events.push(e));

    // Let chokidar arm (ignoreInitial: true), then drop an indexed file into
    // the knowledge dir so the watcher's "add" handler inserts a files row.
    await new Promise((r) => setTimeout(r, 500));
    const rel = "watched-gid.md";
    const abs = path.join(knowledgeDir, rel);
    fs.writeFileSync(abs, "# watched file\n\ncontent", "utf-8");

    // Poll for the watcher-inserted row (chokidar awaitWriteFinish ~300ms).
    let row: Row | undefined;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      row = getDatabase().prepare("SELECT id, gid FROM files WHERE path = ?").get(abs) as Row | undefined;
      if (row) break;
    }

    await watcher.close();

    expect(row, "watcher should have created a files row for the dropped file").toBeDefined();
    expectGidMatchesPk("files", "id", row!);
  });
});
