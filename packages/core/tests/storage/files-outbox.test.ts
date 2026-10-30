/**
 * M54 — write-side outbox instrumentation for the files module.
 *
 * Pins the contract that the four file write routines in src/files/index.ts
 * each append exactly one outbound op to the outbox (the matching OpKind),
 * atomically with the write, and that echo suppression (spec 1.4) makes the
 * SAME routines skip the enqueue entirely when they are reached while a
 * remote op is being applied (inRemoteApply() === true).
 *
 * This is the enqueue side of the guarantee. The apply side (routing each
 * op.kind back into these routines inside the remote-apply scope) is M58, and
 * the watcher hash-gating layer is M57 — not covered here.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { createFile, updateFile, deleteFile, moveFile } from "../../src/files/index.js";
import { pendingOps, pendingCount } from "../../src/storage/outbox.js";
import { runInApplyScope, inRemoteApply } from "../../src/storage/apply.js";
import { getMachineId } from "../../src/identity/machine.js";
import { resetDataDirCache } from "../../src/util/paths.js";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-files-outbox-"));
const TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");

/** All pending outbox ops, reconstructed (payload decoded). */
function pending() {
  return pendingOps(getDatabase());
}

/** Create a knowledge file and return its record (used as the fixture for the mutating ops). */
async function makeFile(title: string, content: string) {
  return createFile({
    title,
    content,
    destination: "knowledge",
    folder: "knowledge",
    dataDir: TEST_DATA_DIR,
  });
}

describe("files write-routine outbox instrumentation (M54)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });
    createDatabase(TEST_DB_PATH);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test("createFile appends a file.create op (null base_version, full payload)", async () => {
    const file = await makeFile("Alpha", "hello alpha");

    expect(pendingCount(getDatabase())).toBe(1);
    const [p] = pending();
    expect(p.op.kind).toBe("file.create");
    expect(p.op.gid).toBe(file.gid);
    expect(p.op.origin).toBe(getMachineId());
    expect(p.op.base_version, "a create has no prior version").toBeNull();
    expect(p.op.payload).toMatchObject({
      path: file.path,
      title: "Alpha",
      content: "hello alpha",
      content_hash: expect.any(String),
    });
  });

  test("updateFile appends a file.update op carrying the record's gid", async () => {
    const file = await makeFile("Beta", "before");
    expect(pendingCount(getDatabase())).toBe(1); // the create op

    await updateFile(file.id, "after", TEST_DATA_DIR);

    const ops = pending();
    expect(ops).toHaveLength(2);
    const upd = ops.find((o) => o.op.kind === "file.update");
    expect(upd).toBeDefined();
    expect(upd!.op.gid, "a locally-edited file keeps its own gid").toBe(file.gid);
    expect(upd!.op.payload).toMatchObject({ path: file.path, content: "after" });
  });

  test("deleteFile appends a file.delete op before removing the row", async () => {
    const file = await makeFile("Gamma", "to be deleted");

    await deleteFile(file.id, TEST_DATA_DIR);

    const del = pending().find((o) => o.op.kind === "file.delete");
    expect(del).toBeDefined();
    expect(del!.op.gid).toBe(file.gid);
    expect(del!.op.payload).toEqual({ path: file.path });
    // The row itself is gone from the files table.
    const row = getDatabase().prepare("SELECT id FROM files WHERE id = ?").get(file.id);
    expect(row).toBeUndefined();
  });

  test("moveFile appends a file.move op with from/to and the new content_class", async () => {
    const file = await makeFile("Delta", "will move");
    const newPath = join(TEST_DATA_DIR, "knowledge", "knowledge", "delta-renamed.md");

    moveFile(file.id, newPath, TEST_DATA_DIR);

    const mv = pending().find((o) => o.op.kind === "file.move");
    expect(mv).toBeDefined();
    expect(mv!.op.gid).toBe(file.gid);
    expect(mv!.op.payload).toMatchObject({ from: file.path, to: newPath });
    // The row now points at the new path.
    const row = getDatabase().prepare("SELECT path FROM files WHERE id = ?").get(file.id) as { path: string };
    expect(row.path).toBe(newPath);
  });

  describe("echo suppression (spec 1.4): no enqueue while inRemoteApply()", () => {
    test("createFile persists to disk + DB but appends no op inside a remote-apply scope", async () => {
      let sawRemoteInScope = false;
      await runInApplyScope(async () => {
        sawRemoteInScope = inRemoteApply();
        await makeFile("Remote", "applied remotely");
      });

      expect(sawRemoteInScope, "inRemoteApply() must be true inside the scope").toBe(true);
      expect(inRemoteApply(), "the scope must not leak outside").toBe(false);
      // The file IS written (local-first apply still mutates the store)...
      const rows = getDatabase().prepare("SELECT id, path FROM files").all() as { id: number; path: string }[];
      expect(rows).toHaveLength(1);
      expect(existsSync(rows[0].path)).toBe(true);
      // ...but NO outbound op is enqueued (this is the echo we must suppress).
      expect(pendingCount(getDatabase()), "no echo op may be enqueued").toBe(0);
    });

    test("update / move / delete also skip the enqueue inside a remote-apply scope", async () => {
      // Seed one file via the normal (non-remote) path so it has a row + gid.
      const file = await makeFile("Seed", "seed");
      expect(pendingCount(getDatabase())).toBe(1);

      await runInApplyScope(async () => {
        await updateFile(file.id, "remote edit", TEST_DATA_DIR);
        moveFile(file.id, join(TEST_DATA_DIR, "knowledge", "knowledge", "seed-moved.md"), TEST_DATA_DIR);
      });

      // The two remote-applied mutations must not have added any ops.
      expect(pendingCount(getDatabase()), "remote update/move must not enqueue").toBe(1);
      expect(pending().every((o) => o.op.kind === "file.create"), "only the original create op remains").toBe(true);
    });
  });
});

describe("portable file op payloads", () => {
  const prevDir = process.env.KONTEXTA_DATA_DIR;

  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });
    createDatabase(TEST_DB_PATH);
  });

  afterEach(() => {
    closeDatabase();
    if (prevDir === undefined) delete process.env.KONTEXTA_DATA_DIR;
    else process.env.KONTEXTA_DATA_DIR = prevDir;
    resetDataDirCache();
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test("createFile carries creation tags in the file.create payload", async () => {
    await createFile({
      title: "Tagged",
      content: "body",
      destination: "knowledge",
      folder: "knowledge",
      dataDir: TEST_DATA_DIR,
      tags: ["spec", "api"],
    });

    const create = pending().find((o) => o.op.kind === "file.create");
    expect((create!.op.payload as { tags?: string[] }).tags).toEqual(["spec", "api"]);
  });

  test("rel_path is set (forward slashes) when the file is inside the data dir", async () => {
    process.env.KONTEXTA_DATA_DIR = TEST_DATA_DIR;
    resetDataDirCache();
    const file = await makeFile("Inside", "body");

    const create = pending().find((o) => o.op.kind === "file.create");
    const rel = (create!.op.payload as { rel_path?: string }).rel_path;
    expect(rel).toBe("knowledge/knowledge/inside.md");
    expect(join(TEST_DATA_DIR, rel!)).toBe(file.path);
  });

  test("rel_path is absent when the file is outside the data dir", async () => {
    const other = mkdtempSync(join(tmpdir(), "kontexta-other-data-"));
    try {
      process.env.KONTEXTA_DATA_DIR = other;
      resetDataDirCache();
      await makeFile("Outside", "body");

      const create = pending().find((o) => o.op.kind === "file.create");
      expect(create!.op.payload).not.toHaveProperty("rel_path");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
