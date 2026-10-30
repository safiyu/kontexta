/**
 * Conflict resolution core engine unit tests — Phase 5 (storage/05-conflicts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  ensureConflictsTable,
  buildConflictPath,
  computeDiff,
  registerConflict,
  registerPathConflict,
  isUnresolvedConflictCopy,
  forkConflictFromOp,
  listConflicts,
  getConflict,
  getConflictById,
  countUnresolvedConflicts,
  resolveConflict,
} from "../../src/storage/conflicts.js";
import { pendingCount, pendingOps } from "../../src/storage/outbox.js";
import type { Op } from "../../src/storage/op.js";
import { resetDataDirCache } from "../../src/util/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_MIGRATIONS_DIR = join(__dirname, "..", "..", "src", "db", "migrations");
const CORE_MIGRATION_FILES = readdirSync(CORE_MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const MACHINE_LOCAL = "1111222233334444";
const MACHINE_REMOTE = "aaaabbbbccccdddd";

function createTestDatabase(machineId: string, machineLabel: string): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of CORE_MIGRATION_FILES) {
    db.exec(readFileSync(join(CORE_MIGRATIONS_DIR, file), "utf-8"));
  }
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('machine_id', ?, datetime('now'))"
  ).run(machineId);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('machine_label', ?, datetime('now'))"
  ).run(machineLabel);
  return db;
}

describe("Conflict resolution core engine (Milestone 77)", () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kxta-conflicts-test-"));
    db = createTestDatabase(MACHINE_LOCAL, "desktop-workstation");
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {}
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("ensureConflictsTable", () => {
    it("creates conflicts table and indexes idempotently", () => {
      ensureConflictsTable(db);
      ensureConflictsTable(db); // Second call should not throw

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conflicts'")
        .all();
      expect(tables).toHaveLength(1);
    });
  });

  describe("computeDiff on large divergent inputs", () => {
    it("stays fast and bounded when the edit distance exceeds the cap", () => {
      const a = Array.from({ length: 6000 }, (_, i) => `a-${i}`).join("\n");
      const b = Array.from({ length: 6000 }, (_, i) => `b-${i}`).join("\n");
      const t0 = Date.now();
      const r = computeDiff(a, b);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r.additions).toBe(6000);
      expect(r.deletions).toBe(6000);
    });

    it("keeps the exact diff when a small edit sits inside long identical text", () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
      const edited = [...lines];
      edited[2500] = "changed";
      const r = computeDiff(lines.join("\n"), edited.join("\n"));
      expect(r.additions).toBe(1);
      expect(r.deletions).toBe(1);
    });
  });

  describe("buildConflictPath", () => {
    it("formats standard conflict path: <filename> (from <machine_label>).<ext>", () => {
      const canonical = join(testDir, "docs", "architecture.md");
      const conflictPath = buildConflictPath(canonical, "macbook-air");
      expect(conflictPath).toBe(join(testDir, "docs", "architecture (from macbook-air).md"));
    });

    it("handles files without extension", () => {
      const canonical = join(testDir, "Dockerfile");
      const conflictPath = buildConflictPath(canonical, "server-01");
      expect(conflictPath).toBe(join(testDir, "Dockerfile (from server-01)"));
    });

    it("sanitizes invalid path characters from machine labels", () => {
      const canonical = join(testDir, "note.txt");
      const conflictPath = buildConflictPath(canonical, "my/machine:bad*name");
      expect(conflictPath).toBe(join(testDir, "note (from my-machine-bad-name).txt"));
    });

    it("appends timestamp when timestamp option is provided", () => {
      const canonical = join(testDir, "note.txt");
      const conflictPath = buildConflictPath(canonical, "laptop", { timestamp: 1700000000000 });
      expect(conflictPath).toBe(join(testDir, "note (from laptop 1700000000000).txt"));
    });
  });

  describe("computeDiff", () => {
    it("returns empty diff for identical contents", () => {
      const result = computeDiff("hello world\nline 2", "hello world\nline 2");
      expect(result.diff).toBe("");
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
    });

    it("computes additions and deletions for changed content", () => {
      const local = "line 1\nold line\nline 3";
      const remote = "line 1\nnew line\nline 3";
      const result = computeDiff(local, remote);
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
      expect(result.diff).toContain("-old line");
      expect(result.diff).toContain("+new line");
      expect(result.diff).toContain(" line 1");
    });

    it("handles completely new or empty content", () => {
      const result = computeDiff("", "added line 1\nadded line 2");
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(0);
      expect(result.diff).toContain("+added line 1");
    });
  });

  describe("registerConflict & forkConflictFromOp", () => {
    it("writes remote content to conflict copy and inserts conflict record", () => {
      const canonicalPath = join(testDir, "notes.md");
      writeFileSync(canonicalPath, "Local content line", "utf8");

      const record = registerConflict(
        {
          gid: `100@${MACHINE_LOCAL}`,
          filePath: canonicalPath,
          origin: MACHINE_REMOTE,
          originLabel: "laptop-remote",
          baseVersion: 1,
          serverSeq: 15,
          remoteContent: "Remote content line",
        },
        db
      );

      expect(record.gid).toBe(`100@${MACHINE_LOCAL}`);
      expect(record.file_path).toBe(canonicalPath);
      expect(record.status).toBe("unresolved");
      expect(record.local_content).toBe("Local content line");
      expect(record.remote_content).toBe("Remote content line");
      expect(record.additions).toBe(1);
      expect(record.deletions).toBe(1);

      // Verify conflict copy exists on disk with remote content
      expect(existsSync(record.conflict_path)).toBe(true);
      expect(readFileSync(record.conflict_path, "utf-8")).toBe("Remote content line");

      // Verify canonical file was NOT overwritten
      expect(readFileSync(canonicalPath, "utf-8")).toBe("Local content line");
    });

    it("updates existing unresolved conflict record if called again for same gid", () => {
      const canonicalPath = join(testDir, "notes.md");
      writeFileSync(canonicalPath, "Initial content", "utf8");

      const rec1 = registerConflict(
        {
          gid: `100@${MACHINE_LOCAL}`,
          filePath: canonicalPath,
          origin: MACHINE_REMOTE,
          remoteContent: "V1 Remote",
        },
        db
      );

      const rec2 = registerConflict(
        {
          gid: `100@${MACHINE_LOCAL}`,
          filePath: canonicalPath,
          origin: MACHINE_REMOTE,
          remoteContent: "V2 Remote",
        },
        db
      );

      expect(rec2.id).toBe(rec1.id);
      expect(rec2.remote_content).toBe("V2 Remote");
      expect(countUnresolvedConflicts(db)).toBe(1);
    });

    it("forks conflict directly from an Op", () => {
      const prevDir = process.env.KONTEXTA_DATA_DIR;
      process.env.KONTEXTA_DATA_DIR = testDir;
      resetDataDirCache();
      try {
        runForkFromOp();
      } finally {
        if (prevDir === undefined) delete process.env.KONTEXTA_DATA_DIR;
        else process.env.KONTEXTA_DATA_DIR = prevDir;
        resetDataDirCache();
      }
    });

    it("maps the origin's absolute path via rel_path and refuses paths outside the data dir", () => {
      const prevDir = process.env.KONTEXTA_DATA_DIR;
      process.env.KONTEXTA_DATA_DIR = testDir;
      resetDataDirCache();
      try {
        mkdirSync(join(testDir, "knowledge"), { recursive: true });
        writeFileSync(join(testDir, "knowledge", "m.md"), "Mine", "utf8");
        const base = { gid: `201@${MACHINE_LOCAL}`, kind: "file.update" as const, origin: MACHINE_REMOTE, base_version: 0, created_at: Date.now() };
        const rec = forkConflictFromOp(
          { ...base, payload: { path: "/Users/other/data/knowledge/m.md", rel_path: "knowledge/m.md", content: "Theirs" } },
          db
        );
        expect(rec.file_path).toBe(join(testDir, "knowledge", "m.md"));
        expect(() =>
          forkConflictFromOp({ ...base, payload: { path: "/etc/passwd", content: "x" } }, db)
        ).toThrow();
      } finally {
        if (prevDir === undefined) delete process.env.KONTEXTA_DATA_DIR;
        else process.env.KONTEXTA_DATA_DIR = prevDir;
        resetDataDirCache();
      }
    });

    function runForkFromOp(): void {
      const canonicalPath = join(testDir, "op-note.md");
      writeFileSync(canonicalPath, "Mine", "utf8");

      // Register remote machine in clients table
      db.prepare(
        "INSERT INTO clients (machine_id, hostname) VALUES (?, ?)"
      ).run(MACHINE_REMOTE, "macbook-pro");

      const op: Op = {
        gid: `200@${MACHINE_LOCAL}`,
        kind: "file.update",
        origin: MACHINE_REMOTE,
        base_version: 0,
        payload: {
          path: canonicalPath,
          title: "Op Note",
          content: "Theirs",
        },
        created_at: Date.now(),
      };

      const record = forkConflictFromOp(op, db, { serverSeq: 42 });
      expect(record.gid).toBe(`200@${MACHINE_LOCAL}`);
      expect(record.origin_label).toBe("macbook-pro");
      expect(record.server_seq).toBe(42);
      expect(record.remote_content).toBe("Theirs");
      expect(record.local_content).toBe("Mine");
      expect(existsSync(record.conflict_path)).toBe(true);
      expect(readFileSync(record.conflict_path, "utf-8")).toBe("Theirs");
    }
  });

  describe("listConflicts, getConflict, and countUnresolvedConflicts", () => {
    it("filters conflicts by status and orders by created_at DESC", () => {
      const file1 = join(testDir, "f1.md");
      const file2 = join(testDir, "f2.md");
      writeFileSync(file1, "f1 local", "utf8");
      writeFileSync(file2, "f2 local", "utf8");

      registerConflict(
        {
          gid: `1@${MACHINE_LOCAL}`,
          filePath: file1,
          origin: MACHINE_REMOTE,
          remoteContent: "f1 remote",
          createdAt: 1000,
        },
        db
      );

      registerConflict(
        {
          gid: `2@${MACHINE_LOCAL}`,
          filePath: file2,
          origin: MACHINE_REMOTE,
          remoteContent: "f2 remote",
          createdAt: 2000,
        },
        db
      );

      const unresolved = listConflicts(db);
      expect(unresolved).toHaveLength(2);
      expect(unresolved[0].gid).toBe(`2@${MACHINE_LOCAL}`);
      expect(unresolved[1].gid).toBe(`1@${MACHINE_LOCAL}`);
      expect(unresolved[0].diff).toBeUndefined();
      expect(unresolved[0].additions).toBeUndefined();

      expect(countUnresolvedConflicts(db)).toBe(2);

      const item = getConflict(`1@${MACHINE_LOCAL}`, db);
      expect(item).not.toBeNull();
      expect(item?.gid).toBe(`1@${MACHINE_LOCAL}`);
      expect(item?.diff).toContain("+f1 remote");

      const byId = getConflictById(item!.id, db);
      expect(byId?.id).toBe(item?.id);
    });
  });

  describe("resolveConflict strategies", () => {
    const seedFile = (filePath: string, gid: string, localText: string) => {
      writeFileSync(filePath, localText, "utf8");
      const insert = db.prepare(`
        INSERT INTO files (path, title, project_id, storage_type, content_class, source_path, content_hash, gid)
        VALUES (?, 'Test File', NULL, 'local', NULL, NULL, 'initialhash', ?)
      `).run(filePath, gid);
      const fileId = Number(insert.lastInsertRowid);
      db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, 'Test File', ?)").run(
        fileId,
        localText
      );
      return fileId;
    };

    it("resolves via keep-server: accepts remote content and deletes conflict copy", async () => {
      const filePath = join(testDir, "keep-server.md");
      const gid = `10@${MACHINE_LOCAL}`;
      const fileId = seedFile(filePath, gid, "Local text");

      const conflict = registerConflict(
        {
          gid,
          filePath,
          origin: MACHINE_REMOTE,
          originLabel: "laptop-b",
          remoteContent: "Remote text from server",
        },
        db
      );

      expect(existsSync(conflict.conflict_path)).toBe(true);

      const result = await resolveConflict(gid, { strategy: "keep-server" }, db);
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("keep-server");

      // Canonical file now holds remote content
      expect(readFileSync(filePath, "utf-8")).toBe("Remote text from server");

      // Conflict copy was deleted
      expect(existsSync(conflict.conflict_path)).toBe(false);

      // FTS and DB updated
      const fts = db.prepare("SELECT content FROM fts_index WHERE rowid = ?").get(fileId) as any;
      expect(fts.content).toBe("Remote text from server");

      // Conflict is marked resolved
      const updated = getConflict(gid, db);
      expect(updated?.status).toBe("resolved");
      expect(updated?.resolution).toBe("keep-server");
      expect(countUnresolvedConflicts(db)).toBe(0);
    });

    it("keep-server enqueues a file.update carrying the remote content", async () => {
      const filePath = join(testDir, "ks-op.md");
      const gid = `11@${MACHINE_LOCAL}`;
      seedFile(filePath, gid, "Local text");
      registerConflict({ gid, filePath, origin: MACHINE_REMOTE, originLabel: "laptop-b", remoteContent: "Server text" }, db);
      const result = await resolveConflict(gid, { strategy: "keep-server" }, db);
      expect(result.outboxOpId).toBeTypeOf("number");
      const ops = pendingOps(db);
      expect(ops).toHaveLength(1);
      expect(ops[0].op.kind).toBe("file.update");
      expect((ops[0].op.payload as { content: string }).content).toBe("Server text");
    });

    describe("path conflicts (same path, different gid)", () => {
      const remoteOp = (gid: string, content: string): Op =>
        ({ gid, kind: "file.create", origin: MACHINE_REMOTE, base_version: null, payload: { path: "x", content }, created_at: 1 }) as unknown as Op;

      it("registers a path conflict, writes the copy, and leaves the local file alone", () => {
        const filePath = join(testDir, "todo.md");
        const localGid = `30@${MACHINE_LOCAL}`;
        const id = seedFile(filePath, localGid, "mine");
        const rec = registerPathConflict({ remoteOp: remoteOp(`9@${MACHINE_REMOTE}`, "theirs"), localFileId: id, localPath: filePath, remoteContent: "theirs" }, db);
        expect(rec.conflict_kind).toBe("path");
        expect(readFileSync(filePath, "utf-8")).toBe("mine");
        expect(readFileSync(rec.conflict_path, "utf-8")).toBe("theirs");
        expect(isUnresolvedConflictCopy(db, rec.conflict_path)).toBe(true);
      });

      it("keep-server adopts the remote gid and enqueues delete(old gid)", async () => {
        const filePath = join(testDir, "adopt.md");
        const localGid = `31@${MACHINE_LOCAL}`;
        const remoteGid = `8@${MACHINE_REMOTE}`;
        const id = seedFile(filePath, localGid, "mine");
        registerPathConflict({ remoteOp: remoteOp(remoteGid, "theirs"), localFileId: id, localPath: filePath, remoteContent: "theirs" }, db);
        await resolveConflict(remoteGid, { strategy: "keep-server" }, db);
        expect(readFileSync(filePath, "utf-8")).toBe("theirs");
        expect((db.prepare("SELECT gid FROM files WHERE id = ?").get(id) as { gid: string }).gid).toBe(remoteGid);
        const kinds = pendingOps(db).map((o) => `${o.op.kind}:${o.op.gid}`);
        expect(kinds).toContain(`file.delete:${localGid}`);
      });

      it("keep-mine turns the copy into a tracked file under the remote gid and enqueues file.move", async () => {
        const filePath = join(testDir, "both.md");
        const localGid = `32@${MACHINE_LOCAL}`;
        const remoteGid = `7@${MACHINE_REMOTE}`;
        const id = seedFile(filePath, localGid, "mine");
        const rec = registerPathConflict({ remoteOp: remoteOp(remoteGid, "theirs"), localFileId: id, localPath: filePath, remoteContent: "theirs" }, db);
        await resolveConflict(remoteGid, { strategy: "keep-mine" }, db);
        expect(existsSync(rec.conflict_path)).toBe(true);
        expect((db.prepare("SELECT path FROM files WHERE gid = ?").get(remoteGid) as { path: string }).path).toBe(rec.conflict_path);
        const move = pendingOps(db).find((o) => o.op.kind === "file.move");
        expect(move?.op.gid).toBe(remoteGid);
        expect(readFileSync(filePath, "utf-8")).toBe("mine");
      });
    });

    it("resolves via keep-mine: preserves local content, enqueues update op, and deletes conflict copy", async () => {
      const filePath = join(testDir, "keep-mine.md");
      const gid = `20@${MACHINE_LOCAL}`;
      seedFile(filePath, gid, "My local changes");

      const conflict = registerConflict(
        {
          gid,
          filePath,
          origin: MACHINE_REMOTE,
          originLabel: "laptop-b",
          baseVersion: 2,
          remoteContent: "Their remote changes",
        },
        db
      );

      expect(pendingCount(db)).toBe(0);

      const result = await resolveConflict(gid, { strategy: "keep-mine" }, db);
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("keep-mine");
      expect(result.outboxOpId).toBeDefined();

      // Canonical file still holds local content
      expect(readFileSync(filePath, "utf-8")).toBe("My local changes");

      // Conflict copy was deleted
      expect(existsSync(conflict.conflict_path)).toBe(false);

      // Outbox op was enqueued with local content
      expect(pendingCount(db)).toBe(1);
      const ops = pendingOps(db);
      expect(ops[0].op.gid).toBe(gid);
      expect(ops[0].op.kind).toBe("file.update");
      expect((ops[0].op.payload as any).content).toBe("My local changes");

      // Conflict is marked resolved
      const updated = getConflict(gid, db);
      expect(updated?.status).toBe("resolved");
      expect(updated?.resolution).toBe("keep-mine");
    });

    it("keep-mine uses the CURRENT file, not the registration snapshot", async () => {
      const filePath = join(testDir, "stale.md");
      const gid = `21@${MACHINE_LOCAL}`;
      seedFile(filePath, gid, "snapshot content");
      registerConflict(
        { gid, filePath, origin: MACHINE_REMOTE, originLabel: "laptop-b", baseVersion: 1, remoteContent: "remote" },
        db
      );

      writeFileSync(filePath, "edited after the conflict was registered", "utf8");
      await resolveConflict(gid, { strategy: "keep-mine" }, db);

      const newer = "edited after the conflict was registered";
      expect(readFileSync(filePath, "utf-8")).toBe(newer);
      const hash = createHash("sha256").update(newer, "utf8").digest("hex");
      const row = db.prepare("SELECT id, content_hash FROM files WHERE gid = ?").get(gid) as { id: number; content_hash: string };
      expect(row.content_hash).toBe(hash);
      const fts = db.prepare("SELECT content FROM fts_index WHERE rowid = ?").get(row.id) as { content: string };
      expect(fts.content).toBe(newer);
      const payload = pendingOps(db)[0].op.payload as any;
      expect(payload.content).toBe(newer);
      expect(payload.content_hash).toBe(hash);
    });

    it("resolves via keep-both: retains canonical file, keeps conflict copy, registers it as a new file, and enqueues create op", async () => {
      const filePath = join(testDir, "keep-both.md");
      const gid = `30@${MACHINE_LOCAL}`;
      seedFile(filePath, gid, "Canonical version");

      const conflict = registerConflict(
        {
          gid,
          filePath,
          origin: MACHINE_REMOTE,
          originLabel: "desktop-c",
          remoteContent: "Forked version",
        },
        db
      );

      const result = await resolveConflict(gid, { strategy: "keep-both" }, db);
      expect(result.success).toBe(true);
      expect(result.strategy).toBe("keep-both");
      expect(result.newFileGid).toBeDefined();

      // Canonical file is intact
      expect(readFileSync(filePath, "utf-8")).toBe("Canonical version");

      // Conflict copy is permanently kept on disk
      expect(existsSync(conflict.conflict_path)).toBe(true);
      expect(readFileSync(conflict.conflict_path, "utf-8")).toBe("Forked version");

      // Conflict copy was registered in files table
      const newFileRow = db
        .prepare("SELECT * FROM files WHERE gid = ?")
        .get(result.newFileGid) as any;
      expect(newFileRow).toBeDefined();
      expect(newFileRow.path).toBe(conflict.conflict_path);

      // FTS has new file
      const newFts = db
        .prepare("SELECT content FROM fts_index WHERE rowid = ?")
        .get(newFileRow.id) as any;
      expect(newFts.content).toBe("Forked version");

      // Outbox op was enqueued for the new file
      const ops = pendingOps(db);
      const createOp = ops.find((o) => o.op.gid === result.newFileGid);
      expect(createOp).toBeDefined();
      expect(createOp?.op.kind).toBe("file.create");

      // Conflict is resolved
      const updated = getConflict(gid, db);
      expect(updated?.status).toBe("resolved");
      expect(updated?.resolution).toBe("keep-both");
    });

    it("resolves via merged: writes custom merged content, enqueues update op, and deletes conflict copy", async () => {
      const filePath = join(testDir, "merged.md");
      const gid = `40@${MACHINE_LOCAL}`;
      const fileId = seedFile(filePath, gid, "Local part\nCommon line");

      const conflict = registerConflict(
        {
          gid,
          filePath,
          origin: MACHINE_REMOTE,
          originLabel: "laptop-b",
          baseVersion: 3,
          remoteContent: "Common line\nRemote part",
        },
        db
      );

      const mergedText = "Local part\nCommon line\nRemote part";
      const result = await resolveConflict(
        gid,
        {
          strategy: "merged",
          mergedContent: mergedText,
        },
        db
      );

      expect(result.success).toBe(true);
      expect(result.strategy).toBe("merged");
      expect(result.outboxOpId).toBeDefined();

      // Canonical file holds merged text
      expect(readFileSync(filePath, "utf-8")).toBe(mergedText);

      // Conflict copy was deleted
      expect(existsSync(conflict.conflict_path)).toBe(false);

      // FTS updated with merged text
      const fts = db.prepare("SELECT content FROM fts_index WHERE rowid = ?").get(fileId) as any;
      expect(fts.content).toBe(mergedText);

      // Outbox op was enqueued
      const ops = pendingOps(db);
      expect(ops[0].op.gid).toBe(gid);
      expect(ops[0].op.kind).toBe("file.update");
      expect((ops[0].op.payload as any).content).toBe(mergedText);

      // Conflict is resolved
      const updated = getConflict(gid, db);
      expect(updated?.status).toBe("resolved");
      expect(updated?.resolution).toBe("merged");
    });

    it("throws when resolving unknown gid, invalid strategy, or merged without mergedContent", async () => {
      await expect(
        resolveConflict("999@unknown", { strategy: "keep-server" }, db)
      ).rejects.toThrow("No unresolved conflict found for gid: 999@unknown");

      const filePath = join(testDir, "err.md");
      const gid = `50@${MACHINE_LOCAL}`;
      seedFile(filePath, gid, "Text");
      registerConflict(
        {
          gid,
          filePath,
          origin: MACHINE_REMOTE,
          remoteContent: "Remote",
        },
        db
      );

      await expect(
        resolveConflict(gid, { strategy: "invalid-strat" as any }, db)
      ).rejects.toThrow("Invalid resolution strategy: invalid-strat");

      await expect(
        resolveConflict(gid, { strategy: "merged" }, db)
      ).rejects.toThrow("Merged resolution strategy requires mergedContent");
    });
  });
});
