/**
 * M60 — Two-process concurrency safety and advisory locking test suite.
 *
 * Verifies that:
 * 1. Advisory locking primitives on `sync_locks` (acquire, release, withSyncLock,
 *    stale recovery, ownership tokens) function correctly and fail closed.
 * 2. Cross-process concurrency between separate OS processes/threads (simulating
 *    apps/mcp and apps/web running concurrently against the same SQLite database
 *    in WAL mode) safely serializes remote operation applications per GID.
 * 3. Overlapping GIDs executed concurrently across multiple worker threads do
 *    not cause duplicate inserts, SQLite constraint failures, or FTS5 rowid drift.
 * 4. Stale locks from crashed processes are cleanly reclaimed after lease expiry.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { resetDataDirCache } from "../../src/util/paths.js";
import {
  acquireSyncLock,
  releaseSyncLock,
  withSyncLock,
  isSyncLockHeld,
  DEFAULT_SYNC_LOCK_LEASE_MS,
} from "../../src/storage/locks.js";
import { applyRemoteOp } from "../../src/storage/apply.js";
import type { Op } from "../../src/storage/op.js";

const projectRoot = join(__dirname, "..", "..");
const distStorageUrl = pathToFileURL(join(projectRoot, "dist", "storage", "index.js")).href;
const distDbUrl = pathToFileURL(join(projectRoot, "dist", "db", "index.js")).href;

function runWorker(
  scriptContent: string,
  workerData: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(scriptContent, { eval: true, workerData });
    let result: any = null;
    worker.on("message", (msg) => {
      result = msg;
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      } else {
        resolve(result);
      }
    });
  });
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("Two-process concurrency and advisory locking (M60)", () => {
  let testDir: string;
  let dbPath: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-two-process-test-"));
    prevDataDir = process.env.KONTEXTA_DATA_DIR;
    process.env.KONTEXTA_DATA_DIR = testDir;
    resetDataDirCache();
    dbPath = join(testDir, "test.db");
    mkdirSync(join(testDir, "knowledge"), { recursive: true });
    createDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (prevDataDir === undefined) delete process.env.KONTEXTA_DATA_DIR;
    else process.env.KONTEXTA_DATA_DIR = prevDataDir;
    resetDataDirCache();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Advisory locking primitives (sync_locks)", () => {
    it("acquires and releases a lock for a free GID", () => {
      const gid = "100@testmach";
      const db = getDatabase();

      expect(isSyncLockHeld(gid, { db })).toBe(false);

      const handle = acquireSyncLock(gid, { db });
      expect(handle).not.toBeNull();
      expect(handle?.gid).toBe(gid);
      expect(typeof handle?.token).toBe("string");
      expect(isSyncLockHeld(gid, { db })).toBe(true);

      // Verify row in sync_locks
      const row = db.prepare("SELECT gid, pid, token, expires_at FROM sync_locks WHERE gid = ?").get(gid) as
        | { gid: string; pid: number; token: string; expires_at: number }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.gid).toBe(gid);
      expect(row?.pid).toBe(process.pid);
      expect(row?.token).toBe(handle?.token);
      expect(row?.expires_at).toBeGreaterThan(Date.now());

      // Release
      const released = releaseSyncLock(handle!, { db });
      expect(released).toBe(true);
      expect(isSyncLockHeld(gid, { db })).toBe(false);

      const remaining = db.prepare("SELECT COUNT(*) as c FROM sync_locks WHERE gid = ?").get(gid) as { c: number };
      expect(remaining.c).toBe(0);
    });

    it("returns null when attempting to acquire an already held, unexpired lock", () => {
      const gid = "101@testmach";
      const db = getDatabase();

      const handle1 = acquireSyncLock(gid, { db, leaseMs: 60_000 });
      expect(handle1).not.toBeNull();

      // Second acquire attempt on the same gid must fail
      const handle2 = acquireSyncLock(gid, { db, leaseMs: 60_000 });
      expect(handle2).toBeNull();

      releaseSyncLock(handle1!, { db });
    });

    it("steals a lock if the previous lock has expired (stale holder recovery)", () => {
      const gid = "102@testmach";
      const db = getDatabase();

      // Seed an expired lock row directly
      const pastTime = Date.now() - 5000;
      db.prepare("INSERT INTO sync_locks (gid, pid, token, expires_at) VALUES (?, ?, ?, ?)").run(
        gid,
        99999, // dead pid
        "old-token",
        pastTime,
      );

      // acquireSyncLock must recognize staleness and claim it
      const handle = acquireSyncLock(gid, { db, leaseMs: 30_000 });
      expect(handle).not.toBeNull();
      expect(handle?.token).not.toBe("old-token");

      const row = db.prepare("SELECT token, pid FROM sync_locks WHERE gid = ?").get(gid) as {
        token: string;
        pid: number;
      };
      expect(row.token).toBe(handle?.token);
      expect(row.pid).toBe(process.pid);

      releaseSyncLock(handle!, { db });
    });

    it("releaseSyncLock is a no-op when the token does not match (ownership protection)", () => {
      const gid = "103@testmach";
      const db = getDatabase();

      const handle = acquireSyncLock(gid, { db });
      expect(handle).not.toBeNull();

      // Attempt to release with a forged token
      const released = releaseSyncLock({ gid, token: "wrong-token" }, { db });
      expect(released).toBe(false);

      // Lock row must still exist
      expect(isSyncLockHeld(gid, { db })).toBe(true);

      // Release with correct token
      const releasedCorrect = releaseSyncLock(handle!, { db });
      expect(releasedCorrect).toBe(true);
      expect(isSyncLockHeld(gid, { db })).toBe(false);
    });

    it("withSyncLock executes fn and automatically releases the lock upon completion", async () => {
      const gid = "104@testmach";
      const db = getDatabase();

      let executed = false;
      const result = await withSyncLock(
        gid,
        async () => {
          expect(isSyncLockHeld(gid, { db })).toBe(true);
          executed = true;
          return "success";
        },
        { db },
      );

      expect(executed).toBe(true);
      expect(result).toBe("success");
      expect(isSyncLockHeld(gid, { db })).toBe(false);
    });

    it("withSyncLock releases the lock even if the user function throws", async () => {
      const gid = "105@testmach";
      const db = getDatabase();

      await expect(
        withSyncLock(
          gid,
          async () => {
            expect(isSyncLockHeld(gid, { db })).toBe(true);
            throw new Error("simulated failure inside withSyncLock");
          },
          { db },
        ),
      ).rejects.toThrow("simulated failure inside withSyncLock");

      expect(isSyncLockHeld(gid, { db })).toBe(false);
    });

    it("withSyncLock times out if the lock is held and cannot be acquired within timeoutMs", async () => {
      const gid = "106@testmach";
      const db = getDatabase();

      // Hold lock
      const handle = acquireSyncLock(gid, { db, leaseMs: 60_000 });
      expect(handle).not.toBeNull();

      await expect(
        withSyncLock(
          gid,
          async () => "never",
          { db, timeoutMs: 80, retryIntervalMs: 15 },
        ),
      ).rejects.toThrow(/timed out.*waiting for lock on gid/);

      releaseSyncLock(handle!, { db });
    });
  });

  describe("Cross-process concurrency safety with worker threads", () => {
    it("concurrently applies remote operations on overlapping GIDs without collisions or corruption", async () => {
      // We spawn 2 worker threads simulating apps/mcp and apps/web applying
      // remote operations with overlapping GIDs concurrently.
      const workerScript = `
        import { applyRemoteOp } from ${JSON.stringify(distStorageUrl)};
        import { createDatabase, closeDatabase } from ${JSON.stringify(distDbUrl)};
        import { parentPort, workerData } from "node:worker_threads";

        const db = createDatabase(workerData.dbPath);
        const results = [];
        try {
          for (const op of workerData.ops) {
            await applyRemoteOp(op, db);
            results.push({ gid: op.gid, ok: true });
          }
          closeDatabase();
          parentPort.postMessage({ ok: true, results });
        } catch (err) {
          try { closeDatabase(); } catch {}
          parentPort.postMessage({ ok: false, error: String(err?.message ?? err), stack: err?.stack });
        }
      `;

      // 4 shared files with overlapping GIDs
      const file1Path = join(testDir, "knowledge", "shared-1.md");
      const file2Path = join(testDir, "knowledge", "shared-2.md");
      const file3Path = join(testDir, "knowledge", "shared-3.md");
      const file4Path = join(testDir, "knowledge", "shared-4.md");

      const gid1 = "201@mach-alpha";
      const gid2 = "202@mach-alpha";
      const gid3 = "203@mach-alpha";
      const gid4 = "204@mach-alpha";

      // Worker 1 operations: creates file 1 & 2, updates file 3 & 4, then sets
      // favorites. The favorite.set ops MUST live in the same worker as (and
      // after) their file.create: the per-gid advisory lock serializes ops within
      // a gid but CANNOT order two different workers' ops on the same gid. If a
      // favorite.set landed in the other worker and ran before its create
      // committed, applyFavoriteSet would find no file and silently no-op,
      // flipping this test's outcome on scheduling. In the real system a single
      // client applies seq-ordered ops sequentially, so a create always precedes
      // any favorite.set for the same gid — this mirrors that guarantee.
      const worker1Ops: Op[] = [
        {
          gid: gid1,
          kind: "file.create",
          origin: "mach-remote",
          base_version: null,
          payload: { path: file1Path, content: "# Shared File 1 (w1 create)", tags: ["w1-tag"] },
          created_at: Date.now(),
        },
        {
          gid: gid2,
          kind: "file.create",
          origin: "mach-remote",
          base_version: null,
          payload: { path: file2Path, content: "# Shared File 2 (w1 create)" },
          created_at: Date.now(),
        },
        {
          gid: gid1,
          kind: "file.update",
          origin: "mach-remote",
          base_version: 1,
          payload: { path: file1Path, content: "# Shared File 1 (w1 update)" },
          created_at: Date.now() + 1,
        },
        {
          gid: gid1,
          kind: "tag.set",
          origin: "mach-remote",
          base_version: 2,
          payload: { tags: ["w2-added-tag"] },
          created_at: Date.now() + 3,
        },
        {
          gid: gid3,
          kind: "file.create",
          origin: "mach-remote",
          base_version: null,
          payload: { path: file3Path, content: "# Shared File 3 (w1 create)" },
          created_at: Date.now(),
        },
        {
          gid: gid4,
          kind: "file.create",
          origin: "mach-remote",
          base_version: null,
          payload: { path: file4Path, content: "# Shared File 4 (w1 create)" },
          created_at: Date.now(),
        },
        {
          gid: gid2,
          kind: "favorite.set",
          origin: "mach-remote",
          base_version: 2,
          payload: { favorite: true },
          created_at: Date.now() + 6,
        },
        {
          gid: gid4,
          kind: "favorite.set",
          origin: "mach-remote",
          base_version: 1,
          payload: { favorite: true },
          created_at: Date.now() + 5,
        },
      ];

      // Worker 2 operations: overlapping GIDs applied concurrently! These are
      // self-healing file.update ops that create their target file if absent,
      // so they block on the per-gid advisory lock until worker 1 has
      // created the file — exercising genuine cross-worker lock contention.
      const worker2Ops: Op[] = [
        {
          gid: gid2,
          kind: "file.update",
          origin: "mach-remote",
          base_version: 1,
          payload: { path: file2Path, content: "# Shared File 2 (w2 update)" },
          created_at: Date.now() + 2,
        },
        {
          gid: gid3,
          kind: "file.update",
          origin: "mach-remote",
          base_version: 1,
          payload: { path: file3Path, content: "# Shared File 3 (w2 update)" },
          created_at: Date.now() + 4,
        },
      ];

      // Close the parent DB connection before launching worker threads
      // so workers open clean connections under WAL mode
      closeDatabase();

      // Launch both workers concurrently
      const [w1Res, w2Res] = await Promise.all([
        runWorker(workerScript, { dbPath, ops: worker1Ops }),
        runWorker(workerScript, { dbPath, ops: worker2Ops }),
      ]);

      expect(w1Res.ok, `Worker 1 failed: ${w1Res.error}`).toBe(true);
      expect(w2Res.ok, `Worker 2 failed: ${w2Res.error}`).toBe(true);

      // Reopen DB connection in test runner to verify database state
      const db = createDatabase(dbPath);

      // 1. Files table: exactly 4 files exist with unique GIDs and paths
      const files = db
        .prepare(`
          SELECT f.id, f.path, f.gid, f.content_hash, (fav.file_id IS NOT NULL) as favorite
          FROM files f
          LEFT JOIN favorites fav ON f.id = fav.file_id
          ORDER BY f.id ASC
        `)
        .all() as Array<{
        id: number;
        path: string;
        gid: string;
        content_hash: string;
        favorite: number | boolean;
      }>;
      expect(files.length).toBe(4);

      const gids = files.map((f) => f.gid).sort();
      expect(gids).toEqual([gid1, gid2, gid3, gid4].sort());

      // 2. FTS index: exactly 4 rows, rowids strictly match files.id
      const ftsRows = db.prepare("SELECT rowid FROM fts_index ORDER BY rowid ASC").all() as Array<{ rowid: number }>;
      expect(ftsRows.length).toBe(4);
      expect(ftsRows.map((r) => r.rowid)).toEqual(files.map((f) => f.id));

      // 3. Files on disk exist and content hashes strictly match
      for (const file of files) {
        expect(existsSync(file.path)).toBe(true);
        const diskContent = readFileSync(file.path, "utf8");
        expect(sha256(diskContent)).toBe(file.content_hash);
      }

      // 4. Favorites applied properly
      const fav2 = files.find((f) => f.gid === gid2);
      expect(Boolean(fav2?.favorite)).toBe(true);

      const fav4 = files.find((f) => f.gid === gid4);
      expect(Boolean(fav4?.favorite)).toBe(true);

      // 5. sync_locks table is completely clean (zero lingering locks)
      const lockCount = db.prepare("SELECT COUNT(*) as c FROM sync_locks").get() as { c: number };
      expect(lockCount.c).toBe(0);
    });

    it("recovers from crashed worker with stale lock across worker threads", async () => {
      const gid = "301@mach-crash";
      const crashFile = join(testDir, "knowledge", "crashed-worker-recovery.md");

      // Worker A acquires lock with a very short lease (100ms) and terminates
      // immediately without releasing it (simulating process crash)
      const crasherScript = `
        import { acquireSyncLock } from ${JSON.stringify(distStorageUrl)};
        import { createDatabase, closeDatabase } from ${JSON.stringify(distDbUrl)};
        import { parentPort, workerData } from "node:worker_threads";

        const db = createDatabase(workerData.dbPath);
        const handle = acquireSyncLock(workerData.gid, { db, leaseMs: 100 });
        // Deliberately exit WITHOUT releaseSyncLock to simulate abrupt crash
        closeDatabase();
        parentPort.postMessage({ acquired: handle !== null });
      `;

      closeDatabase();

      const crasherRes = await runWorker(crasherScript, { dbPath, gid });
      expect(crasherRes.acquired).toBe(true);

      // Worker B attempts to apply remote op on that same GID. It should wait for
      // the 100ms lease to elapse, steal the stale lock, apply the op, and release.
      const workerBScript = `
        import { applyRemoteOp } from ${JSON.stringify(distStorageUrl)};
        import { createDatabase, closeDatabase } from ${JSON.stringify(distDbUrl)};
        import { parentPort, workerData } from "node:worker_threads";

        const db = createDatabase(workerData.dbPath);
        try {
          await applyRemoteOp(workerData.op, { db, lockTimeoutMs: 3000, lockRetryIntervalMs: 25 });
          closeDatabase();
          parentPort.postMessage({ ok: true });
        } catch (err) {
          try { closeDatabase(); } catch {}
          parentPort.postMessage({ ok: false, error: String(err?.message ?? err) });
        }
      `;

      const opToApply: Op = {
        gid,
        kind: "file.create",
        origin: "mach-remote",
        base_version: null,
        payload: { path: crashFile, content: "# Recovered from Stale Lock" },
        created_at: Date.now(),
      };

      const workerBRes = await runWorker(workerBScript, { dbPath, op: opToApply });
      expect(workerBRes.ok, `Worker B failed: ${workerBRes.error}`).toBe(true);

      // Verify DB and disk state
      const db = createDatabase(dbPath);
      const row = db.prepare("SELECT id, path, gid FROM files WHERE gid = ?").get(gid) as {
        id: number;
        path: string;
        gid: string;
      } | undefined;
      expect(row).toBeDefined();
      expect(row?.gid).toBe(gid);
      expect(existsSync(crashFile)).toBe(true);
      expect(readFileSync(crashFile, "utf8")).toBe("# Recovered from Stale Lock");

      // sync_locks must be empty
      const lockCount = db.prepare("SELECT COUNT(*) as c FROM sync_locks").get() as { c: number };
      expect(lockCount.c).toBe(0);
    });

    it("allows disjoint GIDs to execute concurrently without lock contention", async () => {
      const workerScript = `
        import { applyRemoteOp } from ${JSON.stringify(distStorageUrl)};
        import { createDatabase, closeDatabase } from ${JSON.stringify(distDbUrl)};
        import { parentPort, workerData } from "node:worker_threads";

        const db = createDatabase(workerData.dbPath);
        try {
          for (const op of workerData.ops) {
            await applyRemoteOp(op, db);
          }
          closeDatabase();
          parentPort.postMessage({ ok: true });
        } catch (err) {
          try { closeDatabase(); } catch {}
          parentPort.postMessage({ ok: false, error: String(err?.message ?? err) });
        }
      `;

      const fileA = join(testDir, "knowledge", "disjoint-a.md");
      const fileB = join(testDir, "knowledge", "disjoint-b.md");

      const opA: Op = {
        gid: "401@mach-disjoint",
        kind: "file.create",
        origin: "remote",
        base_version: null,
        payload: { path: fileA, content: "File A" },
        created_at: Date.now(),
      };

      const opB: Op = {
        gid: "402@mach-disjoint",
        kind: "file.create",
        origin: "remote",
        base_version: null,
        payload: { path: fileB, content: "File B" },
        created_at: Date.now(),
      };

      closeDatabase();

      const [resA, resB] = await Promise.all([
        runWorker(workerScript, { dbPath, ops: [opA] }),
        runWorker(workerScript, { dbPath, ops: [opB] }),
      ]);

      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);

      const db = createDatabase(dbPath);
      const count = db.prepare("SELECT COUNT(*) as c FROM files WHERE gid IN ('401@mach-disjoint', '402@mach-disjoint')").get() as { c: number };
      expect(count.c).toBe(2);

      const locks = db.prepare("SELECT COUNT(*) as c FROM sync_locks").get() as { c: number };
      expect(locks.c).toBe(0);
    });
  });
});
