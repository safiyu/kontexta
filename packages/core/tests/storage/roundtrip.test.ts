/**
 * Multi-client synchronization integration test with an in-process server — Phase 4 (storage/04-server, milestone 72).
 *
 * Validates the complete local-first replication loop between two in-memory
 * clients (Client A and Client B) synchronizing through an in-process
 * `kontexta-storage-server` instance over stateless HTTP:
 *
 *   Client A (SQLite :memory:) <--> HTTP (in-process) <--> Client B (SQLite :memory:)
 *                                          |
 *                                 kontexta-storage-server
 *                                    (SQLite :memory:)
 *
 * Core guarantees verified:
 *   1. REGISTRATION & HANDSHAKE:
 *      - Machines register via POST /clients and obtain sync tokens.
 *      - Clients connect and verify health + token probe before persisting settings.
 *   2. UNIDIRECTIONAL REPLICATION:
 *      - Local mutation on Client A enqueues outbox op.
 *      - Client A pushes outbox -> server assigns authoritative seq.
 *      - Client B pulls remote ops -> applies cleanly via applyRemoteOp.
 *      - Echo suppression: Client B's outbox remains empty (zero echo loop).
 *      - Own-origin skips: Client A pulling server log skips its own ops.
 *   3. BIDIRECTIONAL REPLICATION:
 *      - Client B updates the shared file -> pushes to server.
 *      - Client A pulls -> applies to its own local store.
 *   4. MULTI-ENTITY REPLICATION:
 *      - Files, tags, folders, project registrations, moves, and deletions.
 *   5. PAGING & INCREMENTAL CATCH-UP:
 *      - Multi-page batches drain in seq order, advancing cursor after each clean page.
 *   6. CONFLICT PRESERVATION (spec 1.7):
 *      - Concurrent offline updates detected by server (stale base_version).
 *      - Conflicted op preserved in authoritative log and surfaced on clients.
 *   7. AUTOMATED SYNC LOOP:
 *      - startSyncLoop / tick() drives round-trip push/pull between two clients.
 *   8. CRASH RECOVERY & RECONNECTION:
 *      - Orphaned 'sent' outbox rows recover to 'pending' and deliver with server dedup.
 *      - Disconnect and reconnect cleanly resume synchronization.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { resetDataDirCache } from "../../src/util/paths.js";
import type { Hono } from "hono";

// Storage server in-process router and app factory
import { createApp } from "../../../storage-server/src/server.js";

// Client storage module under test
import {
  connectEndpoint,
  disconnectEndpoint,
  readEndpointConfig,
  pushOutbox,
  pullRemoteOps,
  getSyncCursor,
  startSyncLoop,
  stopSyncLoop,
} from "../../src/storage/client.js";
import { enqueueOp, pendingCount } from "../../src/storage/outbox.js";
import { resolveConflict } from "../../src/storage/conflicts.js";
import type { Op } from "../../src/storage/op.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Migrations directories
const CORE_MIGRATIONS_DIR = join(__dirname, "..", "..", "src", "db", "migrations");
const SERVER_SCHEMA_PATH = join(__dirname, "..", "..", "..", "storage-server", "src", "db", "schema.sql");

const SERVER_SCHEMA_SQL = readFileSync(SERVER_SCHEMA_PATH, "utf-8");
const CORE_MIGRATION_FILES = readdirSync(CORE_MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** Stable 16-hex machine IDs matching settings.machine_id format. */
const MACHINE_A = "a1b2c3d4e5f60718";
const MACHINE_B = "0f1e2d3c4b5a6978";
const SERVER_BASE_URL = "http://storage.kontexta.local";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Create a fresh in-memory client SQLite database with all migrations 001..015 applied. */
function createClientDatabase(machineId: string, machineLabel: string): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of CORE_MIGRATION_FILES) {
    db.exec(readFileSync(join(CORE_MIGRATIONS_DIR, file), "utf-8"));
  }
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('machine_id', ?, datetime('now'))",
  ).run(machineId);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('machine_label', ?, datetime('now'))",
  ).run(machineLabel);
  return db;
}

/** Create a fresh in-memory storage server database with schema applied. */
function createServerDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SERVER_SCHEMA_SQL);
  return db;
}

/** Create an in-process fetch implementation that routes HTTP requests to a Hono application. */
function makeInProcessFetch(app: Hono): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(urlStr);
    const pathAndQuery = parsed.pathname + parsed.search;
    return app.request(pathAndQuery, init);
  }) as typeof fetch;
}

/** Register a client with the server via POST /clients and return the minted sync token. */
async function registerClientOnServer(
  fetchImpl: typeof fetch,
  machineId: string,
  hostname: string,
): Promise<string> {
  const res = await fetchImpl(`${SERVER_BASE_URL}/clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine_id: machineId, hostname }),
  });
  if (res.status !== 201) {
    throw new Error(`Failed to register client ${machineId}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe("Multi-client synchronization roundtrip (M72)", () => {
  let testDir: string;
  let serverDb: Database.Database;
  let serverApp: Hono;
  let fetchImpl: typeof fetch;

  let dbA: Database.Database;
  let dbB: Database.Database;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "kxta-roundtrip-test-"));
    process.env.KONTEXTA_DATA_DIR = testDir;
    resetDataDirCache();

    // 1. Initialize server
    serverDb = createServerDatabase();
    process.env.KXTA_STORAGE_ALLOW_OPEN_ENROLLMENT = "1";
    serverApp = createApp(serverDb);
    fetchImpl = makeInProcessFetch(serverApp);

    // 2. Initialize in-memory clients
    dbA = createClientDatabase(MACHINE_A, "Client A");
    dbB = createClientDatabase(MACHINE_B, "Client B");

    // 3. Register clients and obtain sync tokens
    tokenA = await registerClientOnServer(fetchImpl, MACHINE_A, "laptop-a");
    tokenB = await registerClientOnServer(fetchImpl, MACHINE_B, "desktop-b");
  });

  afterEach(() => {
    stopSyncLoop();
    delete process.env.KONTEXTA_DATA_DIR;
    resetDataDirCache();
    try {
      dbA?.close();
    } catch {}
    try {
      dbB?.close();
    } catch {}
    try {
      serverDb?.close();
    } catch {}
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Endpoint handshake & connectivity", () => {
    it("connects both clients and verifies initial synchronized state", async () => {
      expect(readEndpointConfig(dbA).connected).toBe(false);
      expect(readEndpointConfig(dbB).connected).toBe(false);

      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

      expect(readEndpointConfig(dbA).connected).toBe(true);
      expect(readEndpointConfig(dbB).connected).toBe(true);
      expect(getSyncCursor(dbA)).toBe(0);
      expect(getSyncCursor(dbB)).toBe(0);
      expect(pendingCount(dbA)).toBe(0);
      expect(pendingCount(dbB)).toBe(0);
    });

    it("fails connectEndpoint when token is rejected", async () => {
      await expect(
        connectEndpoint(dbA, SERVER_BASE_URL, "invalid-token-12345", { fetchImpl }),
      ).rejects.toThrow(/server rejected the token/);
      expect(readEndpointConfig(dbA).connected).toBe(false);
    });
  });

  describe("Unidirectional file replication (Client A -> Server -> Client B)", () => {
    it("propagates file.create from Client A to Client B with echo suppression", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

      const filePath = join(testDir, "knowledge", "doc-1.md");
      const content = "# Document 1\nCreated by Client A";
      const contentHash = sha256(content);
      const fileGid = `101@${MACHINE_A}`;

      // 1. Client A stores file locally and enqueues file.create op
      dbA.prepare(`
        INSERT INTO files (id, path, title, storage_type, content_hash, gid)
        VALUES (101, ?, 'Doc 1', 'local', ?, ?)
      `).run(filePath, contentHash, fileGid);

      const opA: Op = {
        gid: fileGid,
        kind: "file.create",
        origin: MACHINE_A,
        base_version: null,
        payload: {
          path: filePath,
          title: "Doc 1",
          content,
          content_hash: contentHash,
          storage_type: "local",
        },
        created_at: 1_700_000_000_100,
      };
      enqueueOp(dbA, opA);

      expect(pendingCount(dbA)).toBe(1);
      expect(pendingCount(dbB)).toBe(0);

      // 2. Client A pushes to server
      const pushResA = await pushOutbox(dbA, { fetchImpl });
      expect(pushResA.error).toBeNull();
      expect(pushResA.attempted).toBe(1);
      expect(pushResA.delivered).toBe(1);
      expect(pushResA.conflicts).toHaveLength(0);
      expect(pendingCount(dbA)).toBe(0);

      // Verify server op log
      const serverOps = serverDb.prepare("SELECT * FROM ops ORDER BY seq ASC").all() as Array<{
        seq: number;
        gid: string;
        kind: string;
        origin: string;
        status: string;
      }>;
      expect(serverOps).toHaveLength(1);
      expect(serverOps[0].seq).toBe(1);
      expect(serverOps[0].gid).toBe(fileGid);
      expect(serverOps[0].kind).toBe("file.create");
      expect(serverOps[0].origin).toBe(MACHINE_A);
      expect(serverOps[0].status).toBe("accepted");

      // 3. Client B pulls from server
      const pullResB = await pullRemoteOps(dbB, { fetchImpl });
      expect(pullResB.error).toBeNull();
      expect(pullResB.polled).toBe(1);
      expect(pullResB.applied).toBe(1);
      expect(pullResB.cursor).toBe(1);
      expect(getSyncCursor(dbB)).toBe(1);

      // Verify Client B received the file in SQLite and disk
      const fileOnB = dbB.prepare("SELECT * FROM files WHERE gid = ?").get(fileGid) as {
        id: number;
        path: string;
        title: string;
        content_hash: string;
        gid: string;
      };
      expect(fileOnB).toBeDefined();
      expect(fileOnB.path).toBe(filePath);
      expect(fileOnB.title).toBe("Doc 1");
      expect(fileOnB.content_hash).toBe(contentHash);

      // Verify FTS on Client B
      const ftsOnB = dbB.prepare("SELECT * FROM fts_index WHERE rowid = ?").get(fileOnB.id) as {
        title: string;
        content: string;
      };
      expect(ftsOnB).toBeDefined();
      expect(ftsOnB.title).toBe("Doc 1");
      expect(ftsOnB.content).toBe(content);

      // Verify physical disk file written
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe(content);

      // Crucial: Echo suppression guarantee (spec 1.4)
      // Client B must NOT have enqueued an outbox op for this remote write!
      expect(pendingCount(dbB)).toBe(0);

      // 4. Client A pulls: must skip own-origin ops and advance cursor
      const pullResA = await pullRemoteOps(dbA, { fetchImpl });
      expect(pullResA.error).toBeNull();
      expect(pullResA.polled).toBe(1);
      expect(pullResA.applied).toBe(0); // skipped own-origin
      expect(pullResA.cursor).toBe(1);
      expect(getSyncCursor(dbA)).toBe(1);
      expect(pendingCount(dbA)).toBe(0);
    });
  });

  describe("Bidirectional file replication (Client B -> Server -> Client A)", () => {
    it("propagates file.update from Client B back to Client A", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

      const filePath = join(testDir, "knowledge", "shared-doc.md");
      const initialContent = "# Shared Doc\nInitial content";
      const fileGid = `200@${MACHINE_A}`;

      // Seed file on A and sync to B
      dbA.prepare(`
        INSERT INTO files (id, path, title, storage_type, content_hash, gid)
        VALUES (200, ?, 'Shared Doc', 'local', ?, ?)
      `).run(filePath, sha256(initialContent), fileGid);

      enqueueOp(dbA, {
        gid: fileGid,
        kind: "file.create",
        origin: MACHINE_A,
        base_version: null,
        payload: {
          path: filePath,
          title: "Shared Doc",
          content: initialContent,
          content_hash: sha256(initialContent),
          storage_type: "local",
        },
        created_at: 1_700_000_000_200,
      });

      await pushOutbox(dbA, { fetchImpl });
      await pullRemoteOps(dbB, { fetchImpl });
      await pullRemoteOps(dbA, { fetchImpl }); // Client A advances cursor to 1

      expect(getSyncCursor(dbA)).toBe(1);
      expect(getSyncCursor(dbB)).toBe(1);
      expect(readFileSync(filePath, "utf-8")).toBe(initialContent);

      // Now Client B edits the file
      const updatedContent = "# Shared Doc\nUpdated by Client B with important findings.";
      const updatedHash = sha256(updatedContent);

      dbB.prepare(`
        UPDATE files SET content_hash = ?, updated_at = datetime('now') WHERE gid = ?
      `).run(updatedHash, fileGid);

      const updateOpB: Op = {
        gid: fileGid,
        kind: "file.update",
        origin: MACHINE_B,
        base_version: 0, // send-time protocol will rewrite this based on acked version (1)
        payload: {
          path: filePath,
          title: "Shared Doc",
          content: updatedContent,
          content_hash: updatedHash,
        },
        created_at: 1_700_000_000_300,
      };
      enqueueOp(dbB, updateOpB);
      expect(pendingCount(dbB)).toBe(1);

      // Client B pushes update
      const pushResB = await pushOutbox(dbB, { fetchImpl });
      expect(pushResB.error).toBeNull();
      expect(pushResB.delivered).toBe(1);
      expect(pendingCount(dbB)).toBe(0);

      // Client A pulls update
      const pullResA = await pullRemoteOps(dbA, { fetchImpl });
      expect(pullResA.error).toBeNull();
      expect(pullResA.polled).toBe(1);
      expect(pullResA.applied).toBe(1);
      expect(pullResA.cursor).toBe(2);
      expect(getSyncCursor(dbA)).toBe(2);

      // Verify file updated on Client A
      const fileOnA = dbA.prepare("SELECT content_hash FROM files WHERE gid = ?").get(fileGid) as {
        content_hash: string;
      };
      expect(fileOnA.content_hash).toBe(updatedHash);
      expect(readFileSync(filePath, "utf-8")).toBe(updatedContent);
      expect(pendingCount(dbA)).toBe(0); // no echo op
    });
  });

  describe("Multi-entity synchronization (files, tags, projects, moves, deletes)", () => {
    it("synchronizes projects, files with tags, file moves, and deletes bidirectionally", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

      // 1. Client A creates a file with tags and registers a project
      const fileGidA = `301@${MACHINE_A}`;
      const projGidA = `302@${MACHINE_A}`;
      const initialPath = join(testDir, "project-a", "spec.md");
      const movedPath = join(testDir, "project-a", "spec-v2.md");
      const fileContent = "# Spec\nInitial specification text";

      mkdirSync(dirname(initialPath), { recursive: true });
      writeFileSync(initialPath, fileContent, "utf8");

      dbA.prepare(`
        INSERT INTO files (id, path, title, storage_type, content_hash, gid)
        VALUES (301, ?, 'Spec', 'local', ?, ?)
      `).run(initialPath, sha256(fileContent), fileGidA);

      enqueueOp(dbA, {
        gid: projGidA,
        kind: "project.register",
        origin: MACHINE_A,
        base_version: null,
        payload: {
          name: "Project Kontexta",
          slug: "kontexta-core",
          path: join(testDir, "project-a"),
          description: "Core context management system",
        },
        created_at: 1_700_000_001_000,
      });

      enqueueOp(dbA, {
        gid: fileGidA,
        kind: "file.create",
        origin: MACHINE_A,
        base_version: null,
        payload: {
          path: initialPath,
          title: "Spec",
          content: fileContent,
          content_hash: sha256(fileContent),
          tags: ["specs", "architecture"],
        },
        created_at: 1_700_000_001_001,
      });

      // Client A pushes -> Client B pulls
      await pushOutbox(dbA, { fetchImpl });
      await pullRemoteOps(dbB, { fetchImpl });

      // Verify Client B received the project and file with tags
      const projOnB = dbB.prepare("SELECT name, slug FROM projects WHERE gid = ?").get(projGidA) as {
        name: string;
        slug: string;
      };
      expect(projOnB).toBeDefined();
      expect(projOnB.name).toBe("Project Kontexta");
      expect(projOnB.slug).toBe("kontexta-core");

      const fileOnB = dbB.prepare("SELECT id, path FROM files WHERE gid = ?").get(fileGidA) as {
        id: number;
        path: string;
      };
      expect(fileOnB).toBeDefined();
      expect(fileOnB.path).toBe(initialPath);

      const tagsOnB = dbB
        .prepare("SELECT t.name FROM tags t JOIN file_tags ft ON ft.tag_id = t.id WHERE ft.file_id = ?")
        .all(fileOnB.id) as Array<{ name: string }>;
      expect(tagsOnB.map((t) => t.name).sort()).toEqual(["architecture", "specs"]);

      // 2. Client B moves the file from initialPath to movedPath
      dbB.prepare("UPDATE files SET path = ? WHERE gid = ?").run(movedPath, fileGidA);
      enqueueOp(dbB, {
        gid: fileGidA,
        kind: "file.move",
        origin: MACHINE_B,
        base_version: 0,
        payload: { from: initialPath, to: movedPath },
        created_at: 1_700_000_001_002,
      });

      await pushOutbox(dbB, { fetchImpl });
      await pullRemoteOps(dbA, { fetchImpl });

      // Verify file path moved on Client A
      const fileOnA = dbA.prepare("SELECT path FROM files WHERE gid = ?").get(fileGidA) as {
        path: string;
      };
      expect(fileOnA.path).toBe(movedPath);
      expect(existsSync(movedPath)).toBe(true);

      // 3. Client A deletes the file
      enqueueOp(dbA, {
        gid: fileGidA,
        kind: "file.delete",
        origin: MACHINE_A,
        base_version: 0,
        payload: { path: movedPath },
        created_at: 1_700_000_001_003,
      });

      await pushOutbox(dbA, { fetchImpl });
      await pullRemoteOps(dbB, { fetchImpl });

      // Verify file deleted on Client B
      const deletedOnB = dbB.prepare("SELECT id FROM files WHERE gid = ?").get(fileGidA);
      expect(deletedOnB).toBeUndefined();
      expect(existsSync(movedPath)).toBe(false);

      expect(pendingCount(dbA)).toBe(0);
      expect(pendingCount(dbB)).toBe(0);
    });
  });

  describe("Paging and incremental synchronization", () => {
    it("pages multiple batches cleanly without skipping history or corrupting cursor", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

      // Client A enqueues 6 operations with valid numeric GIDs
      for (let i = 1; i <= 6; i++) {
        enqueueOp(dbA, {
          gid: `${500 + i}@${MACHINE_A}`,
          kind: "project.register",
          origin: MACHINE_A,
          base_version: null,
          payload: {
            name: `Project ${i}`,
            slug: `project-${i}`,
            path: join(testDir, `proj-${i}`),
          },
          created_at: 1_700_000_002_000 + i,
        });
      }

      await pushOutbox(dbA, { fetchImpl });

      // Client B pulls with pageLimit = 2 (triggers 3 iterations: 2 + 2 + 2 ops)
      const pullRes = await pullRemoteOps(dbB, { fetchImpl, pageLimit: 2 });
      expect(pullRes.error).toBeNull();
      expect(pullRes.polled).toBe(6);
      expect(pullRes.applied).toBe(6);
      expect(pullRes.cursor).toBe(6);
      expect(getSyncCursor(dbB)).toBe(6);

      const count = dbB.prepare("SELECT COUNT(*) AS c FROM projects WHERE slug LIKE 'project-%'").get() as {
        c: number;
      };
      expect(count.c).toBe(6);
    });
  });

  describe("Conflict detection & preservation (spec 1.7)", () => {
    it("preserves server-flagged conflict when two offline clients update the same record", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

      const sharedGid = `999@${MACHINE_A}`;
      const filePath = join(testDir, "conflict-file.md");

      // Initial create on A, synced to B
      enqueueOp(dbA, {
        gid: sharedGid,
        kind: "file.create",
        origin: MACHINE_A,
        base_version: null,
        payload: { path: filePath, title: "Base Title", content: "Base content" },
        created_at: 1_700_000_003_000,
      });
      await pushOutbox(dbA, { fetchImpl });
      await pullRemoteOps(dbB, { fetchImpl });
      await pullRemoteOps(dbA, { fetchImpl });

      // Both clients now offline: both make conflicting edits
      // Client A update
      enqueueOp(dbA, {
        gid: sharedGid,
        kind: "file.update",
        origin: MACHINE_A,
        base_version: 0,
        payload: { path: filePath, title: "Title by A", content: "Content by A" },
        created_at: 1_700_000_003_100,
      });

      // Client B update
      enqueueOp(dbB, {
        gid: sharedGid,
        kind: "file.update",
        origin: MACHINE_B,
        base_version: 0,
        payload: { path: filePath, title: "Title by B", content: "Content by B" },
        created_at: 1_700_000_003_200,
      });

      // Client A pushes first -> version 2 accepted
      const pushA = await pushOutbox(dbA, { fetchImpl });
      expect(pushA.error).toBeNull();
      expect(pushA.delivered).toBe(1);
      expect(pushA.conflicts).toHaveLength(0);

      // Client B pushes second -> server detects base_version 1 < current 2 -> status: 'conflict'
      const pushB = await pushOutbox(dbB, { fetchImpl });
      expect(pushB.error).toBeNull();
      expect(pushB.delivered).toBe(1);
      expect(pushB.conflicts).toHaveLength(1);
      expect(pushB.conflicts[0].gid).toBe(sharedGid);

      // Server op log preserves both
      const ops = serverDb
        .prepare("SELECT seq, status, origin FROM ops WHERE gid = ? ORDER BY seq ASC")
        .all(sharedGid) as Array<{
        seq: number;
        status: string;
        origin: string;
      }>;
      expect(ops).toHaveLength(3); // create (accepted), update A (accepted), update B (conflict)
      expect(ops[0].status).toBe("accepted");
      expect(ops[1].status).toBe("accepted");
      expect(ops[2].status).toBe("conflict");
      expect(ops[2].origin).toBe(MACHINE_B);

      // Client A pulls: receives the conflict-flagged op from B
      const pullA = await pullRemoteOps(dbA, { fetchImpl });
      expect(pullA.error).toBeNull();
      expect(pullA.conflicts).toHaveLength(1);
      expect(pullA.conflicts[0].gid).toBe(sharedGid);
    });
  });

  describe("Per-gid version tracking and conflict convergence", () => {
    const seedShared = async (gid: string, filePath: string): Promise<void> => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "Base content");
      dbA.prepare(
        "INSERT INTO files (id, path, title, storage_type, content_hash, gid) VALUES (500, ?, 'Base', 'local', ?, ?)",
      ).run(filePath, sha256("Base content"), gid);
      enqueueOp(dbA, {
        gid,
        kind: "file.create",
        origin: MACHINE_A,
        base_version: null,
        payload: { path: filePath, title: "Base", content: "Base content" },
        created_at: 1_700_000_004_000,
      });
      await pushOutbox(dbA, { fetchImpl });
      await pullRemoteOps(dbB, { fetchImpl });
      await pullRemoteOps(dbA, { fetchImpl });
    };
    const update = (gid: string, origin: string, filePath: string, content: string): Op => ({
      gid,
      kind: "file.update",
      origin,
      base_version: 0,
      payload: { path: filePath, title: "Base", content },
      created_at: 1_700_000_004_100,
    });

    it("B's first edit of a gid created on A, after pulling, is based on A's version and is accepted", async () => {
      const gid = `500@${MACHINE_A}`;
      await seedShared(gid, join(testDir, "knowledge", "shared-v.md"));

      enqueueOp(dbB, update(gid, MACHINE_B, join(testDir, "knowledge", "shared-v.md"), "B edit"));
      const pushB = await pushOutbox(dbB, { fetchImpl });
      expect(pushB.error).toBeNull();
      expect(pushB.conflicts).toHaveLength(0);

      const rows = serverDb
        .prepare("SELECT origin, base_version, status FROM ops WHERE gid = ? ORDER BY seq ASC")
        .all(gid) as Array<{ origin: string; base_version: number | null; status: string }>;
      expect(rows[1]).toEqual({ origin: MACHINE_B, base_version: 1, status: "accepted" });
    });

    it("an edit based on a stale version is still flagged as a conflict", async () => {
      const gid = `500@${MACHINE_A}`;
      const filePath = join(testDir, "knowledge", "shared-v.md");
      await seedShared(gid, filePath);

      enqueueOp(dbA, update(gid, MACHINE_A, filePath, "A edit"));
      await pushOutbox(dbA, { fetchImpl });
      enqueueOp(dbB, update(gid, MACHINE_B, filePath, "B stale edit"));
      const pushB = await pushOutbox(dbB, { fetchImpl });
      expect(pushB.conflicts).toHaveLength(1);
    });

    it("keep-mine after a pulled conflict converges: the resolution op is accepted, not re-flagged", async () => {
      const gid = `500@${MACHINE_A}`;
      const filePath = join(testDir, "knowledge", "shared-v.md");
      await seedShared(gid, filePath);

      writeFileSync(filePath, "A edit");
      enqueueOp(dbA, update(gid, MACHINE_A, filePath, "A edit"));
      await pushOutbox(dbA, { fetchImpl });
      enqueueOp(dbB, update(gid, MACHINE_B, filePath, "B stale edit"));
      expect((await pushOutbox(dbB, { fetchImpl })).conflicts).toHaveLength(1);

      const pullA = await pullRemoteOps(dbA, { fetchImpl });
      expect(pullA.error).toBeNull();
      expect(readFileSync(filePath, "utf-8")).toBe("A edit");
      expect(dbA.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'unresolved'").get()).toEqual({ n: 1 });

      const res = await resolveConflict(gid, { strategy: "keep-mine" }, dbA);
      expect(res.success).toBe(true);
      const pushA = await pushOutbox(dbA, { fetchImpl });
      expect(pushA.error).toBeNull();
      expect(pushA.delivered).toBeGreaterThan(0);
      expect(pushA.conflicts).toHaveLength(0);
    });
  });

  describe("Automated sync loop roundtrip (startSyncLoop)", () => {
    it("synchronizes changes between two live loop handles using tick()", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

      // In production, each machine runs its own OS process with a single sync loop.
      // We simulate Machine A's process running its loop:
      const loopA = startSyncLoop(dbA, { fetchImpl, autoStart: false });

      const gidA = `701@${MACHINE_A}`;
      const filePathA = join(testDir, "loop-file-a.md");
      const contentA = "# Loop Test A\nVerified via tick()";

      enqueueOp(dbA, {
        gid: gidA,
        kind: "file.create",
        origin: MACHINE_A,
        base_version: null,
        payload: { gid: gidA, path: filePathA, title: "Loop File A", content: contentA },
        created_at: Date.now(),
      });

      // Loop A ticks: pushes op to server
      const tickA1 = await loopA.tick();
      expect(tickA1.phase).toBe("ok");
      expect(tickA1.push?.delivered).toBe(1);
      expect(loopA.state().pending).toBe(0);
      expect(loopA.state().connected).toBe(true);

      // Stop Loop A before simulating Machine B's process loop (singleton per process)
      loopA.stop();

      // Now simulate Machine B's process running its loop:
      const loopB = startSyncLoop(dbB, { fetchImpl, autoStart: false });

      // Loop B ticks: pulls op from server and applies
      const tickB1 = await loopB.tick();
      expect(tickB1.phase).toBe("ok");
      expect(tickB1.pull?.applied).toBe(1);

      // Verify Client B received the file
      const fileB = dbB.prepare("SELECT title, path FROM files WHERE gid = ?").get(gidA) as {
        title: string;
        path: string;
      };
      expect(fileB).toBeDefined();
      expect(fileB.title).toBe("Loop File A");
      expect(fileB.path).toBe(filePathA);
      expect(existsSync(filePathA)).toBe(true);
      expect(readFileSync(filePathA, "utf-8")).toBe(contentA);

      // Client B now produces an op
      const gidB = `702@${MACHINE_B}`;
      const filePathB = join(testDir, "loop-file-b.md");
      const contentB = "# Loop Test B\nVerified via tick() from B";

      enqueueOp(dbB, {
        gid: gidB,
        kind: "file.create",
        origin: MACHINE_B,
        base_version: null,
        payload: { gid: gidB, path: filePathB, title: "Loop File B", content: contentB },
        created_at: Date.now(),
      });

      // Loop B ticks: pushes B's op
      const tickB2 = await loopB.tick();
      expect(tickB2.phase).toBe("ok");
      expect(tickB2.push?.delivered).toBe(1);
      expect(loopB.state().pending).toBe(0);
      loopB.stop();

      // Back to Machine A's loop: pulls B's op
      const loopA2 = startSyncLoop(dbA, { fetchImpl, autoStart: false });
      const tickA2 = await loopA2.tick();
      expect(tickA2.phase).toBe("ok");
      expect(tickA2.pull?.applied).toBe(1);

      const fileA = dbA.prepare("SELECT title, path FROM files WHERE gid = ?").get(gidB) as {
        title: string;
        path: string;
      };
      expect(fileA).toBeDefined();
      expect(fileA.title).toBe("Loop File B");
      expect(readFileSync(filePathB, "utf-8")).toBe(contentB);
      loopA2.stop();
    });
  });

  describe("Crash recovery & idempotency", () => {
    it("re-queues orphaned 'sent' rows and de-duplicates them on retry", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });

      const gid = `801@${MACHINE_A}`;
      const opId = enqueueOp(dbA, {
        gid,
        kind: "project.register",
        origin: MACHINE_A,
        base_version: null,
        payload: { name: "Crash Project", slug: "crash-proj", path: join(testDir, "crash") },
        created_at: Date.now(),
      });

      // Simulate a process crash mid-POST where the outbox row was left as 'sent'
      dbA.prepare("UPDATE outbox SET status = 'sent' WHERE id = ?").run(opId);

      // pushOutbox must recover the 'sent' row to 'pending' and deliver it
      const pushRes = await pushOutbox(dbA, { fetchImpl });
      expect(pushRes.error).toBeNull();
      expect(pushRes.delivered).toBe(1);

      const row = dbA.prepare("SELECT status, server_seq FROM outbox WHERE id = ?").get(opId) as {
        status: string;
        server_seq: number;
      };
      expect(row.status).toBe("acked");
      expect(row.server_seq).toBe(1);

      // Retrying the same push is a safe no-op that preserves server_seq
      dbA.prepare("UPDATE outbox SET status = 'pending' WHERE id = ?").run(opId);
      const retryRes = await pushOutbox(dbA, { fetchImpl });
      expect(retryRes.delivered).toBe(1);

      const serverCount = serverDb.prepare("SELECT COUNT(*) AS c FROM ops WHERE gid = ?").get(gid) as {
        c: number;
      };
      expect(serverCount.c).toBe(1); // not double-inserted
    });

    it("resumes synchronization cleanly after disconnect and reconnect", async () => {
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      expect(readEndpointConfig(dbA).connected).toBe(true);

      disconnectEndpoint(dbA);
      expect(readEndpointConfig(dbA).connected).toBe(false);

      const disconnectedPush = await pushOutbox(dbA, { fetchImpl });
      expect(disconnectedPush.error).toBe("not connected");

      // Reconnect
      await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
      expect(readEndpointConfig(dbA).connected).toBe(true);

      const reconnectedPush = await pushOutbox(dbA, { fetchImpl });
      expect(reconnectedPush.error).toBeNull();
    });
  });
});
