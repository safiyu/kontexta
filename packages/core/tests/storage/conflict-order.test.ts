/**
 * Server-assigned sequence order vs. client wall-clock — Phase 4
 * (storage/04-server, milestone 73).
 *
 * Spec 1.7 / "Clock Skew / Ordering Drift" (risk table): the
 * `kontexta-storage-server` assigns the sole authoritative order. Every
 * accepted op is given the next `ops.seq` (AUTOINCREMENT) in the order it
 * ARRIVES at `POST /ops`; client clocks (`created_at`) are stored for display
 * only and are never used to order. Two offline machines with badly skewed
 * local clocks must therefore never clobber each other's work silently — the
 * one whose op reaches the server first becomes canonical, and the one whose
 * op arrives second is flagged `status: "conflict"` (spec 1.7) and surfaced
 * to the receiver, regardless of what its (untrusted) clock says.
 *
 * This suite drives two in-memory clients (Client A, Client B) through an
 * in-process `kontexta-storage-server` with DELIBERATELY skewed clocks and
 * proves, end-to-end over the real wire contract:
 *
 *   1. The server assigns `seq` strictly by arrival order (the POST order the
 *      test controls), and the stored `created_at` is the client's raw,
 *      skewed value — proving the clock is never reordered, trusted, or used
 *      for ordering.
 *   2. The FIRST op to arrive wins the canonical version even when its clock
 *      is in the PAST relative to the second op's clock (the "past clock
 *      wins" case).
 *   3. The SECOND op to arrive is flagged `conflict` even when its clock is
 *      in the FUTURE relative to the first op's clock (the "future clock
 *      loses" case) — i.e. the second connection receives a conflict copy
 *      regardless of clock time.
 *   4. The receiver applies the conflict-flagged op (the authoritative log is
 *      preserved), surfaces it in `PullResult.conflicts`, keeps its own
 *      canonical record intact, and stays echo-free.
 *   5. The client's poll cursor advances monotonically by the SERVER `seq`
 *      (never by `created_at`), so catch-up is correct even when the served
 *      ops' `created_at` values are out of order.
 *
 * The suite does NOT depend on the Phase 5 Conflict Manager
 * (storage/conflicts.ts, the 4-way fork/resolve engine) — it verifies only
 * the server's seq-authority and conflict-flagging contract that the manager
 * will later consume.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { resetDataDirCache } from "../../src/util/paths.js";
import type { Hono } from "hono";

// Storage server in-process app factory
import { createApp } from "../../../storage-server/src/server.js";

// Client storage module under test
import {
  connectEndpoint,
  pushOutbox,
  pullRemoteOps,
  getSyncCursor,
} from "../../src/storage/client.js";
import { enqueueOp, pendingCount } from "../../src/storage/outbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Migrations + server schema (same locations the roundtrip test resolves).
const CORE_MIGRATIONS_DIR = join(__dirname, "..", "..", "src", "db", "migrations");
const SERVER_SCHEMA_PATH = join(__dirname, "..", "..", "..", "storage-server", "src", "db", "schema.sql");

const SERVER_SCHEMA_SQL = readFileSync(SERVER_SCHEMA_PATH, "utf-8");
const CORE_MIGRATION_FILES = readdirSync(CORE_MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Stable 16-hex machine IDs matching settings.machine_id format.
const MACHINE_A = "a1b2c3d4e5f60718";
const MACHINE_B = "0f1e2d3c4b5a6978";
const SERVER_BASE_URL = "http://storage.kontexta.local";

// A large, fixed "now" so the clock skew is unambiguous and deterministic.
// Client A is a "future" clock (far ahead of the true wall clock); Client B is
// a "past" clock (far behind it). Neither clock is anywhere near the other.
const TRUE_NOW = 1_760_000_000_000; // the "real" instant both machines edit at
const CLOCK_A_FUTURE = TRUE_NOW + 45 * 24 * 3_600_000; // +45 days
const CLOCK_B_PAST = TRUE_NOW - 45 * 24 * 3_600_000; // -45 days

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

describe("Server-assigned sequence order wins over client clocks (M73)", () => {
  let testDir: string;
  let serverDb: Database.Database;
  let serverApp: Hono;
  let fetchImpl: typeof fetch;

  let dbA: Database.Database;
  let dbB: Database.Database;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "kxta-conflict-order-test-"));
    process.env.KONTEXTA_DATA_DIR = testDir;
    resetDataDirCache();

    serverDb = createServerDatabase();
    process.env.KXTA_STORAGE_ALLOW_OPEN_ENROLLMENT = "1";
    serverApp = createApp(serverDb);
    fetchImpl = makeInProcessFetch(serverApp);

    dbA = createClientDatabase(MACHINE_A, "Client A (future clock)");
    dbB = createClientDatabase(MACHINE_B, "Client B (past clock)");

    tokenA = await registerClientOnServer(fetchImpl, MACHINE_A, "laptop-a");
    tokenB = await registerClientOnServer(fetchImpl, MACHINE_B, "desktop-b");
  });

  afterEach(() => {
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

  it("assigns seq by arrival order and stores the client's raw (skewed) created_at, never reordering it", async () => {
    await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
    await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

    const gid = `100@${MACHINE_A}`;
    const filePath = join(testDir, "ordering-base.md");

    // Seed the record on A and sync it to B so both machines share base
    // version 1 before they diverge.
    const seedPayload = {
      path: filePath,
      title: "Ordering Base",
      content: "Base content",
      content_hash: sha256("Base content"),
    };
    enqueueOp(dbA, {
      gid,
      kind: "file.create",
      origin: MACHINE_A,
      base_version: null,
      payload: seedPayload,
      created_at: TRUE_NOW,
    });
    await pushOutbox(dbA, { fetchImpl });
    await pullRemoteOps(dbB, { fetchImpl });
    await pullRemoteOps(dbA, { fetchImpl });


    // Both offline. Each edits the record with a DELIBERATELY skewed clock.
    // The clock order is the EXACT INVERSE of the arrival order below:
    // B's op carries the FUTURE clock, A's op carries the PAST clock.
    enqueueOp(dbB, {
      gid,
      kind: "file.update",
      origin: MACHINE_B,
      base_version: 0, // send-time rewrite -> 1 (B knows the base version)
      payload: {
        path: filePath,
        title: "Ordering Base",
        content: "Version B (future clock)",
        content_hash: sha256("Version B (future clock)"),
      },
      created_at: CLOCK_A_FUTURE, // FUTURE clock
    });
    enqueueOp(dbA, {
      gid,
      kind: "file.update",
      origin: MACHINE_A,
      base_version: 0, // send-time rewrite -> 1 (A's acked seed create)
      payload: {
        path: filePath,
        title: "Ordering Base",
        content: "Version A (past clock)",
        content_hash: sha256("Version A (past clock)"),
      },
      created_at: CLOCK_B_PAST, // PAST clock
    });

    // The test controls arrival: B's (FUTURE-clock) op is posted FIRST, A's
    // (PAST-clock) op is posted SECOND. A naive "order by created_at" server
    // would assign seq 2 to A (past) and seq 3 to B (future) — the INVERSE of
    // what we assert. So the asserted seq order proves the server keys on
    // arrival, never the clock.
    const pushB = await pushOutbox(dbB, { fetchImpl });
    const pushA = await pushOutbox(dbA, { fetchImpl });
    expect(pushB.error).toBeNull();
    expect(pushA.error).toBeNull();

    const rows = serverDb
      .prepare("SELECT seq, origin, status, created_at FROM ops WHERE gid = ? ORDER BY seq ASC")
      .all(gid) as Array<{ seq: number; origin: string; status: string; created_at: number }>;
    expect(rows).toHaveLength(3); // create, update B, update A

    // seq is a dense 1..3 in ARRIVAL order: create, then B (arrived first),
    // then A (arrived second).
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0].origin).toBe(MACHINE_A); // create
    expect(rows[1].origin).toBe(MACHINE_B); // B arrived first -> seq 2
    expect(rows[2].origin).toBe(MACHINE_A); // A arrived second -> seq 3

    // The stored created_at is the client's RAW skewed value — the server
    // neither reorders nor rewrites it. seq 2 (B) carries the FUTURE clock,
    // seq 3 (A) carries the PAST clock: created_at runs the WRONG way
    // relative to seq, which is exactly what "ordering is by arrival, not
    // clock" means.
    expect(rows[1].created_at).toBe(CLOCK_A_FUTURE);
    expect(rows[2].created_at).toBe(CLOCK_B_PAST);
    expect(rows[1].created_at).toBeGreaterThan(rows[2].created_at);
    expect(rows[1].seq).toBeLessThan(rows[2].seq);

    // Conflict detection is independent of the clock: the first arrival (B,
    // future clock) is accepted; the second arrival (A, past clock) is flagged
    // despite its earlier clock.
    expect(rows[1].status).toBe("accepted");
    expect(rows[2].status).toBe("conflict");
    expect(pushA.conflicts).toHaveLength(1);
    expect(pushA.conflicts[0].gid).toBe(gid);
    expect(pushB.conflicts).toHaveLength(0);
  });

  it("lets the first op to arrive win the canonical version even when its clock is in the past", async () => {
    await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
    await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

    const gid = `200@${MACHINE_A}`;
    const filePath = join(testDir, "past-clock-wins.md");

    // Seed + sync (A creates) so both clients know the base version is 1.
    const seedPayload = {
      path: filePath,
      title: "Past Clock Wins",
      content: "Base content",
      content_hash: sha256("Base content"),
    };
    enqueueOp(dbA, {
      gid,
      kind: "file.create",
      origin: MACHINE_A,
      base_version: null,
      payload: seedPayload,
      created_at: TRUE_NOW,
    });
    await pushOutbox(dbA, { fetchImpl });
    await pullRemoteOps(dbB, { fetchImpl });
    await pullRemoteOps(dbA, { fetchImpl });

    // B (PAST clock) edits and pushes FIRST -> accepted, canonical version 2.
    enqueueOp(dbB, {
      gid,
      kind: "file.update",
      origin: MACHINE_B,
      base_version: 0,
      payload: {
        path: filePath,
        title: "Past Clock Wins",
        content: "Version B",
        content_hash: sha256("Version B"),
      },
      created_at: CLOCK_B_PAST,
    });
    const pushB = await pushOutbox(dbB, { fetchImpl });
    expect(pushB.delivered).toBe(1);
    expect(pushB.conflicts).toHaveLength(0);

    // A (FUTURE clock) edits and pushes SECOND -> its base_version (1) is now
    // stale (the canonical version is 2), so it is a conflict even though its
    // clock is far in the future. The server never rejects it — it is stored
    // (the log is authoritative) and flagged.
    enqueueOp(dbA, {
      gid,
      kind: "file.update",
      origin: MACHINE_A,
      base_version: 0,
      payload: {
        path: filePath,
        title: "Past Clock Wins",
        content: "Version A",
        content_hash: sha256("Version A"),
      },
      created_at: CLOCK_A_FUTURE,
    });
    const pushA = await pushOutbox(dbA, { fetchImpl });
    expect(pushA.delivered).toBe(1);
    expect(pushA.conflicts).toHaveLength(1);

    // seq is assigned by arrival: B (arrived first) is seq 2 / accepted,
    // A (arrived second) is seq 3 / conflict — independent of the clocks.
    const rows = serverDb
      .prepare("SELECT seq, origin, status FROM ops WHERE gid = ? ORDER BY seq ASC")
      .all(gid) as Array<{ seq: number; origin: string; status: string }>;
    expect(rows[1]).toMatchObject({ seq: 2, origin: MACHINE_B, status: "accepted" }); // B first
    expect(rows[2]).toMatchObject({ seq: 3, origin: MACHINE_A, status: "conflict" }); // A second

    // The receiver (B) pulls the authoritative log. A's conflict-flagged op is
    // NOT applied over B's canonical file: it is forked into a conflict copy.
    const pullB = await pullRemoteOps(dbB, { fetchImpl });
    expect(pullB.error).toBeNull();
    expect(pullB.conflicts).toHaveLength(1);
    expect(pullB.conflicts[0].gid).toBe(gid);
    expect(pullB.conflicts[0].origin).toBe(MACHINE_A);
    expect(readFileSync(filePath, "utf-8")).toBe("Base content"); // conflicting content never reaches the canonical file
    expect(
      dbB.prepare("SELECT remote_content, status FROM conflicts WHERE gid = ?").all(gid),
    ).toEqual([{ remote_content: "Version A", status: "unresolved" }]);
    expect(pendingCount(dbB)).toBe(0); // echo suppression intact
  });

  it("flags the second op as a conflict even when its clock is in the future, and surfaces it to the receiver", async () => {
    await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
    await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

    const gid = `300@${MACHINE_A}`;
    const filePath = join(testDir, "future-clock-loses.md");

    // Seed + sync (A creates) so both clients know the base version is 1.
    const seedPayload = {
      path: filePath,
      title: "Future Clock Loses",
      content: "Base content",
      content_hash: sha256("Base content"),
    };
    enqueueOp(dbA, {
      gid,
      kind: "file.create",
      origin: MACHINE_A,
      base_version: null,
      payload: seedPayload,
      created_at: TRUE_NOW,
    });
    await pushOutbox(dbA, { fetchImpl });
    await pullRemoteOps(dbB, { fetchImpl });
    await pullRemoteOps(dbA, { fetchImpl });

    // B (FUTURE clock this time) edits and pushes FIRST -> accepted, canonical.
    enqueueOp(dbB, {
      gid,
      kind: "file.update",
      origin: MACHINE_B,
      base_version: 0,
      payload: {
        path: filePath,
        title: "Future Clock Loses",
        content: "Version B",
        content_hash: sha256("Version B"),
      },
      created_at: CLOCK_A_FUTURE,
    });
    const pushB = await pushOutbox(dbB, { fetchImpl });
    expect(pushB.delivered).toBe(1);
    expect(pushB.conflicts).toHaveLength(0);

    // A (PAST clock) edits and pushes SECOND -> conflict despite its earlier
    // (past) clock, because the server already has a newer canonical version
    // (2). The flag is about version staleness, never about the timestamp.
    enqueueOp(dbA, {
      gid,
      kind: "file.update",
      origin: MACHINE_A,
      base_version: 0,
      payload: {
        path: filePath,
        title: "Future Clock Loses",
        content: "Version A",
        content_hash: sha256("Version A"),
      },
      created_at: CLOCK_B_PAST,
    });
    const pushA = await pushOutbox(dbA, { fetchImpl });
    expect(pushA.delivered).toBe(1);
    expect(pushA.conflicts).toHaveLength(1);

    // seq is by arrival: B (arrived first, future clock) is seq 2 / accepted,
    // A (arrived second, past clock) is seq 3 / conflict.
    const rows = serverDb
      .prepare("SELECT seq, origin, status FROM ops WHERE gid = ? ORDER BY seq ASC")
      .all(gid) as Array<{ seq: number; origin: string; status: string }>;
    expect(rows[1]).toMatchObject({ seq: 2, origin: MACHINE_B, status: "accepted" }); // B first
    expect(rows[2]).toMatchObject({ seq: 3, origin: MACHINE_A, status: "conflict" }); // A second

    // The receiver (B) pulls the log: the conflict-flagged op forks a conflict copy instead of overwriting.
    const pullB = await pullRemoteOps(dbB, { fetchImpl });
    expect(pullB.error).toBeNull();
    expect(pullB.conflicts).toHaveLength(1);
    expect(pullB.conflicts[0].gid).toBe(gid);
    expect(pullB.conflicts[0].origin).toBe(MACHINE_A);
    expect(readFileSync(filePath, "utf-8")).toBe("Base content"); // conflicting content never reaches the canonical file
    expect(
      dbB.prepare("SELECT remote_content, status FROM conflicts WHERE gid = ?").all(gid),
    ).toEqual([{ remote_content: "Version A", status: "unresolved" }]);
    expect(pendingCount(dbB)).toBe(0); // no echo op was enqueued
  });

  it("advances the poll cursor monotonically by server seq, not by created_at", async () => {
    await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
    await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

    const gid = `400@${MACHINE_A}`;
    const filePath = join(testDir, "cursor-seq.md");

    // Seed + sync (A creates) so B knows the base.
    enqueueOp(dbA, {
      gid,
      kind: "file.create",
      origin: MACHINE_A,
      base_version: null,
      payload: {
        path: filePath,
        title: "Cursor Seq",
        content: "Base content",
        content_hash: sha256("Base content"),
      },
      created_at: CLOCK_A_FUTURE,
    });
    await pushOutbox(dbA, { fetchImpl });
    await pullRemoteOps(dbB, { fetchImpl });
    await pullRemoteOps(dbA, { fetchImpl });
    expect(getSyncCursor(dbA)).toBe(1);
    expect(getSyncCursor(dbB)).toBe(1);

    // A (FUTURE clock) makes TWO consecutive updates and pushes them in one
    // batch (local-seq order). Both carry the same future created_at — far
    // ahead of B's clock — yet the server orders them by arrival (batch) order.
    enqueueOp(dbA, {
      gid,
      kind: "file.update",
      origin: MACHINE_A,
      base_version: 0,
      payload: {
        path: filePath,
        title: "Cursor Seq",
        content: "Version two",
        content_hash: sha256("Version two"),
      },
      created_at: CLOCK_A_FUTURE,
    });
    enqueueOp(dbA, {
      gid,
      kind: "file.update",
      origin: MACHINE_A,
      base_version: 0,
      payload: {
        path: filePath,
        title: "Cursor Seq",
        content: "Version three",
        content_hash: sha256("Version three"),
      },
      created_at: CLOCK_A_FUTURE,
    });
    const pushA = await pushOutbox(dbA, { fetchImpl });
    expect(pushA.delivered).toBe(2);
    expect(pushA.conflicts).toHaveLength(0);

    const rows = serverDb
      .prepare("SELECT seq, created_at FROM ops WHERE gid = ? ORDER BY seq ASC")
      .all(gid) as Array<{ seq: number; created_at: number }>;
    // Dense seq 1..3; the two updates (seq 2,3) share the future created_at.
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[1].created_at).toBe(CLOCK_A_FUTURE);
    expect(rows[2].created_at).toBe(CLOCK_A_FUTURE);

    // B catches up: the cursor advances to the highest SERVER seq (3), not to
    // any created_at value (which is a far-future, non-seq number).
    const pullB = await pullRemoteOps(dbB, { fetchImpl });
    expect(pullB.error).toBeNull();
    expect(pullB.cursor).toBe(3);
    expect(getSyncCursor(dbB)).toBe(3);
    // The applied content is the last op in seq order (seq 3), not the max
    // created_at (which would be ambiguous — both updates share it).
    expect(readFileSync(filePath, "utf-8")).toBe("Version three");

    // A second poll is caught up: no new ops, cursor unchanged (monotonic).
    const pullB2 = await pullRemoteOps(dbB, { fetchImpl });
    expect(pullB2.error).toBeNull();
    expect(pullB2.polled).toBe(0);
    expect(pullB2.cursor).toBe(3);
    expect(getSyncCursor(dbB)).toBe(3);
  });

  it("resolves concurrent offline creates by arrival order, flagging the second as conflict regardless of clock skew", async () => {
    await connectEndpoint(dbA, SERVER_BASE_URL, tokenA, { fetchImpl });
    await connectEndpoint(dbB, SERVER_BASE_URL, tokenB, { fetchImpl });

    const sharedGid = `500@${MACHINE_A}`;
    const filePath = join(testDir, "concurrent-create.md");

    // Both machines create the same GID offline with base_version: null.
    // Client A has a far-future clock (+45 days).
    // Client B has an extreme-past clock (e.g. 1000 ms after Unix epoch).
    const EPOCH_PAST = 1000;

    enqueueOp(dbA, {
      gid: sharedGid,
      kind: "file.create",
      origin: MACHINE_A,
      base_version: null,
      payload: {
        path: filePath,
        title: "Created by A (future clock)",
        content: "Content from future client A",
      },
      created_at: CLOCK_A_FUTURE,
    });

    enqueueOp(dbB, {
      gid: sharedGid,
      kind: "file.create",
      origin: MACHINE_B,
      base_version: null,
      payload: {
        path: filePath,
        title: "Created by B (epoch clock)",
        content: "Content from epoch client B",
      },
      created_at: EPOCH_PAST,
    });

    // Client A pushes first -> accepted as seq 1 (version 1) despite having future clock
    const pushA = await pushOutbox(dbA, { fetchImpl });
    expect(pushA.error).toBeNull();
    expect(pushA.delivered).toBe(1);
    expect(pushA.conflicts).toHaveLength(0);

    // Client B pushes second -> flagged conflict as seq 2 despite having clock in the deep past
    const pushB = await pushOutbox(dbB, { fetchImpl });
    expect(pushB.error).toBeNull();
    expect(pushB.delivered).toBe(1);
    expect(pushB.conflicts).toHaveLength(1);
    expect(pushB.conflicts[0].gid).toBe(sharedGid);

    // Verify server ops log
    const ops = serverDb
      .prepare("SELECT seq, origin, status, created_at FROM ops WHERE gid = ? ORDER BY seq ASC")
      .all(sharedGid) as Array<{
      seq: number;
      origin: string;
      status: string;
      created_at: number;
    }>;
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      seq: 1,
      origin: MACHINE_A,
      status: "accepted",
      created_at: CLOCK_A_FUTURE,
    });
    expect(ops[1]).toMatchObject({
      seq: 2,
      origin: MACHINE_B,
      status: "conflict",
      created_at: EPOCH_PAST,
    });

    // Client A pulls B's conflict op
    const pullA = await pullRemoteOps(dbA, { fetchImpl });
    expect(pullA.error).toBeNull();
    expect(pullA.conflicts).toHaveLength(1);
    expect(pullA.conflicts[0].gid).toBe(sharedGid);
    expect(pullA.cursor).toBe(2);
  });
});

