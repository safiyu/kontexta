/**
 * M57 — write-side outbox instrumentation for the filesystem watcher.
 *
 * Pins the contract that the watcher's three event handlers in
 * src/watcher/index.ts each append the matching outbound op to the outbox,
 * atomically with the DB write:
 *
 *   handleWatcherAdd     -> file.create   (null base_version, full payload)
 *   updateFileHash       -> file.update   (base_version 0; ONLY when the stored
 *                                          content hash actually changed)
 *   handleWatcherUnlink  -> file.delete   (base_version 0, { path } payload)
 *
 * It also pins the two echo-suppression guarantees (spec 1.4) that keep a
 * remote op from re-enqueuing itself when its local application touches files:
 *
 *   HASH GATE   — updateFileHash is a no-op (no op) when the stored content
 *                 hash already matches, so a change event that we ourselves
 *                 just caused (our own write) never produces a duplicate op.
 *
 *   REMOTE SCOPE — every handler still persists to DB + disk but enqueues ZERO
 *                 ops when reached while a remote op is being applied
 *                 (inRemoteApply() === true).
 *
 * The handlers are driven directly (deterministic) rather than through
 * chokidar so the op-kind / gid / payload / base_version contract is pinned
 * exactly. The chokidar wiring that funnels events into these same handlers is
 * covered by tests/watcher.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import {
  handleWatcherAdd,
  updateFileHash,
  handleWatcherUnlink,
} from "../../src/watcher/index.js";
import { pendingOps, pendingCount } from "../../src/storage/outbox.js";
import { runInApplyScope, inRemoteApply } from "../../src/storage/apply.js";
import { getMachineId } from "../../src/identity/machine.js";
import { resetDataDirCache } from "../../src/util/paths.js";
import { registerConflict } from "../../src/storage/conflicts.js";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-watcher-outbox-"));
const TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");
const KNOWLEDGE_DIRS = [join(TEST_DATA_DIR, "knowledge")];

/** All pending outbox ops, reconstructed (payload decoded). */
function pending() {
  return pendingOps(getDatabase());
}

/** Write a file on disk under the knowledge dir and ingest it via the add handler. */
function dropFile(basename: string, content: string): string {
  const filePath = join(TEST_DATA_DIR, "knowledge", basename);
  writeFileSync(filePath, content, "utf-8");
  handleWatcherAdd(filePath, KNOWLEDGE_DIRS);
  return filePath;
}

/** Read a files row (or undefined) by path. */
function rowByPath(p: string) {
  return getDatabase().prepare("SELECT * FROM files WHERE path = ?").get(p);
}

describe("watcher outbox instrumentation (M57)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });
    process.env.KONTEXTA_DATA_DIR = TEST_DATA_DIR;
    resetDataDirCache();
    createDatabase(TEST_DB_PATH);
  });

  afterEach(() => {
    delete process.env.KONTEXTA_DATA_DIR;
    resetDataDirCache();
    closeDatabase();
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("handleWatcherAdd appends a file.create op (null base_version, full payload)", () => {
    const filePath = dropFile("dropped.md", "dropped content");

    expect(pendingCount(getDatabase())).toBe(1);
    const [p] = pending();
    expect(p.op.kind).toBe("file.create");
    expect(p.op.origin).toBe(getMachineId());
    expect(p.op.base_version, "a create has no prior version").toBeNull();
    expect(p.op.payload).toMatchObject({
      path: filePath,
      title: "dropped",
      content: "dropped content",
      content_hash: expect.any(String),
    });
    // The op carries the row's gid (a watcher-created row gets a local gid).
    const row = rowByPath(filePath) as { gid: string } | undefined;
    expect(row).toBeDefined();
    expect(p.op.gid).toBe(row!.gid);
  });

  it("file.create carries rel_path and project_gid and no project_id", () => {
    dropFile("portable.md", "x");
    const [p] = pending();
    const payload = p.op.payload as Record<string, unknown>;
    expect(payload.rel_path).toBe("knowledge/portable.md");
    expect("project_gid" in payload).toBe(true);
    expect("project_id" in payload).toBe(false);
  });

  it("a conflict copy appearing or changing on disk enqueues no op and creates no files row", () => {
    const canonical = dropFile("note.md", "mine");
    const before = pendingCount(getDatabase());
    const rec = registerConflict(
      { gid: (rowByPath(canonical) as { gid: string }).gid, filePath: canonical, origin: "aaaabbbbccccdddd", originLabel: "laptop", remoteContent: "theirs" },
      getDatabase(),
    );
    handleWatcherAdd(rec.conflict_path, KNOWLEDGE_DIRS);
    writeFileSync(rec.conflict_path, "edited copy", "utf-8");
    updateFileHash(rec.conflict_path, KNOWLEDGE_DIRS);
    expect(pendingCount(getDatabase())).toBe(before);
    expect(rowByPath(rec.conflict_path)).toBeUndefined();
  });

  it("a file outside the data dir (a project repo) enqueues no file op but still gets a files row", () => {
    const repo = mkdtempSync(join(tmpdir(), "kxta-repo-"));
    try {
      getDatabase().prepare("INSERT INTO projects (name, slug, path) VALUES ('P', 'p', ?)").run(repo);
      const filePath = join(repo, "spec.md");
      writeFileSync(filePath, "repo file", "utf-8");
      handleWatcherAdd(filePath, KNOWLEDGE_DIRS);
      expect(rowByPath(filePath)).toBeDefined();
      expect(pendingCount(getDatabase())).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("handleWatcherAdd enqueues only once (an already-present row is a no-op)", () => {
    const filePath = join(TEST_DATA_DIR, "knowledge", "once.md");
    writeFileSync(filePath, "same", "utf-8");

    handleWatcherAdd(filePath, KNOWLEDGE_DIRS);
    handleWatcherAdd(filePath, KNOWLEDGE_DIRS); // OR IGNORE: no fresh row

    expect(pendingCount(getDatabase()), "the second add must not enqueue").toBe(1);
  });

  it("updateFileHash appends a file.update op when the stored hash changed", () => {
    const filePath = dropFile("edited.md", "before");
    expect(pendingCount(getDatabase())).toBe(1); // the create op

    writeFileSync(filePath, "after", "utf-8");
    updateFileHash(filePath, KNOWLEDGE_DIRS);

    const upd = pending().find((o) => o.op.kind === "file.update");
    expect(upd).toBeDefined();
    expect(upd!.op.gid).toBe((rowByPath(filePath) as { gid: string }).gid);
    expect(upd!.op.base_version).toBe(0);
    expect(upd!.op.payload).toMatchObject({ path: filePath, title: "edited", content: "after" });
  });

  it("updateFileHash enqueues nothing when the hash is unchanged (hash gate, spec 1.4)", () => {
    const filePath = dropFile("stable.md", "stable");
    expect(pendingCount(getDatabase())).toBe(1);

    // Re-run with the content unchanged: the stored hash already matches, so
    // the watcher must NOT produce a duplicate outbound op (our own write's echo).
    updateFileHash(filePath, KNOWLEDGE_DIRS);

    expect(pendingCount(getDatabase()), "no-change re-check must not enqueue").toBe(1);
    expect(pending().every((o) => o.op.kind === "file.create"), "only the original create remains").toBe(true);
  });

  it("handleWatcherUnlink appends a file.delete op before removing the row", () => {
    const filePath = dropFile("gone.md", "to be unlinked");

    handleWatcherUnlink(filePath);

    const del = pending().find((o) => o.op.kind === "file.delete");
    expect(del).toBeDefined();
    expect(del!.op.base_version).toBe(0);
    expect(del!.op.payload).toEqual({ path: filePath, rel_path: "knowledge/gone.md" });
    expect(rowByPath(filePath), "the row is gone after unlink").toBeUndefined();
  });

  it("handleWatcherUnlink on an unknown path enqueues nothing", () => {
    expect(pendingCount(getDatabase())).toBe(0);
    handleWatcherUnlink(join(TEST_DATA_DIR, "knowledge", "never-existed.md"));
    expect(pendingCount(getDatabase()), "no row to delete, no op").toBe(0);
  });

  describe("echo suppression (spec 1.4): no enqueue while inRemoteApply()", () => {
    it("handleWatcherAdd persists to DB but appends no op inside a remote-apply scope", () => {
      let sawRemoteInScope = false;
      const filePath = join(TEST_DATA_DIR, "knowledge", "remote-add.md");
      runInApplyScope(() => {
        sawRemoteInScope = inRemoteApply();
        writeFileSync(filePath, "applied remotely", "utf-8");
        handleWatcherAdd(filePath, KNOWLEDGE_DIRS);
      });

      expect(sawRemoteInScope, "inRemoteApply() must be true inside the scope").toBe(true);
      expect(inRemoteApply(), "the scope must not leak outside").toBe(false);
      // The row IS written (local-first apply still mutates the store)...
      expect(rowByPath(filePath)).toBeDefined();
      // ...but NO outbound op is enqueued (this is the echo we must suppress).
      expect(pendingCount(getDatabase()), "no echo op may be enqueued").toBe(0);
    });

    it("updateFileHash and handleWatcherUnlink skip the enqueue inside a remote-apply scope", () => {
      const filePath = dropFile("remote-edit.md", "seed");
      expect(pendingCount(getDatabase())).toBe(1); // the create op

      runInApplyScope(() => {
        writeFileSync(filePath, "remote edit", "utf-8");
        updateFileHash(filePath, KNOWLEDGE_DIRS); // remote update: must not enqueue
        handleWatcherUnlink(filePath); // remote delete: must not enqueue
      });

      expect(pendingCount(getDatabase()), "remote update/delete must not enqueue").toBe(1);
      expect(pending().every((o) => o.op.kind === "file.create"), "only the original create remains").toBe(true);
      // The remote delete DID remove the row (apply still mutates the store).
      expect(rowByPath(filePath)).toBeUndefined();
    });
  });
});
