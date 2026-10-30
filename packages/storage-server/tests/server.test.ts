/**
 * Storage-server API tests — Phase 4 (storage/04-server, milestone 66).
 *
 * Exercises ALL four routes (routes/ops.ts) end-to-end through Hono's
 * in-process test client (`app.request` — no sockets, no listener, safe for
 * serverless CI), against a REAL SQLite database: a fresh in-memory
 * connection per test, loaded with the actual `src/db/schema.sql`, so the
 * schema and the routes are tested exactly as deployed.
 *
 * Coverage map
 * ============
 *   GET  /health     liveness + version, no auth
 *   POST /clients    token mint (once), hash-only storage, re-registration,
 *                    machine_id / body validation
 *   Bearer auth      401s (missing / wrong scheme / unknown token), scheme
 *                    case-insensitivity, pepper binding
 *   POST /ops        fail-closed op validation (whole batch), server seq
 *                    assignment, spec 1.7 conflict detection (stale
 *                    base_version + offline-both-create), idempotent retries
 *                    via (origin, client_seq), batch cap
 *   GET  /ops        since/limit cursor polling, paging, default + capped
 *                    limit, payload round-trip, 400s, last_seen bookkeeping
 *   exported helpers parseGetOpsParams / extractBearerToken /
 *                    validateIncomingOp (unit)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOpsRouter,
  parseGetOpsParams,
  extractBearerToken,
  validateIncomingOp,
  DEFAULT_OPS_LIMIT,
  MAX_OPS_LIMIT,
} from "../src/routes/ops.js";
import { DEFAULT_PEPPER, hashToken } from "../src/auth.js";
import { VERSION } from "../src/index.js";
import { defaultPepperRefusal, isLoopbackHost } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(here, "..", "src", "db", "schema.sql"), "utf-8");

/** Two stable 16-hex machine ids (the shape of `settings.machine_id`). */
const MACHINE_A = "a1b2c3d4e5f60718";
const MACHINE_B = "0f1e2d3c4b5a6978";
/** A second pepper to prove token hashes are bound to the deployment secret. */
const OTHER_PEPPER = "unit-test-pepper-2";

const T0 = 1_700_000_000_000; // a fixed, plausible client wall-clock (ms)

/** Open a fresh in-memory DB with the real schema applied. */
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

let db: Database.Database;
let app: ReturnType<typeof createOpsRouter>;

beforeEach(() => {
  db = freshDb();
  app = createOpsRouter(db, { allowOpenEnrollment: true });
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** POST /clients with a well-formed body; returns the Response. */
async function register(machineId: string, hostname?: string) {
  return app.request("/clients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      hostname === undefined ? { machine_id: machineId } : { machine_id: machineId, hostname },
    ),
  });
}

/** Register a machine and return its (one-time) token. */
async function tokenFor(machineId: string = MACHINE_A): Promise<string> {
  const res = await register(machineId, "laptop");
  const body = (await res.json()) as { token: string | null };
  if (res.status !== 201 || typeof body.token !== "string") {
    throw new Error(`register(${machineId}) failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.token;
}

async function postOps(token: string, body: unknown) {
  return app.request("/ops", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** One valid op; `overrides` mutate any field (including illegal ones). */
function makeOp(overrides: Record<string, unknown> = {}) {
  return {
    gid: "1@deadbeef00001111",
    kind: "file.create",
    origin: MACHINE_A,
    base_version: null,
    payload: { path: "/kb/notes/a.md", content: "hello" },
    created_at: T0,
    ...overrides,
  };
}

/** Count ops rows (optionally filtered by gid). */
function opsCount(gid?: string): number {
  const row = gid
    ? db.prepare("SELECT COUNT(*) AS n FROM ops WHERE gid = ?").get(gid)
    : db.prepare("SELECT COUNT(*) AS n FROM ops").get();
  return (row as { n: number }).n;
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("responds 200 with service identity, without auth", async () => {
    const before = Date.now();
    const res = await app.request("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("kontexta-storage-server");
    expect(body.version).toBe(VERSION);
    expect(typeof body.time).toBe("number");
    // The clock is the SERVER's (spec 1.7: client clocks are untrusted).
    expect(body.time as number).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// POST /clients
// ---------------------------------------------------------------------------

describe("POST /clients", () => {
  it("issues a one-time 256-bit token on first contact (201)", async () => {
    const res = await register(MACHINE_A, "laptop-a");
    const body = (await res.json()) as {
      machine_id: string;
      registered: boolean;
      token: string | null;
    };

    expect(res.status).toBe(201);
    expect(body.machine_id).toBe(MACHINE_A);
    expect(body.registered).toBe(true);
    // 32 random bytes as lowercase hex (auth.ts TOKEN_BYTES).
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);

    // The token immediately works on an authenticated route.
    const ops = await app.request("/ops", {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(ops.status).toBe(200);
  });

  it("stores only the peppered hash, never the plaintext", async () => {
    const res = await register(MACHINE_A);
    const token = (await res.json() as { token: string }).token;

    const row = db
      .prepare("SELECT token_hash FROM clients WHERE machine_id = ?")
      .get(MACHINE_A) as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token, DEFAULT_PEPPER));
    expect(row.token_hash).not.toBe(token);
  });

  it("re-registration issues no token; the original stays valid", async () => {
    const first = await register(MACHINE_A, "laptop-a");
    const token = (await first.json() as { token: string }).token;

    const second = await register(MACHINE_A, "laptop-a");
    const body = (await second.json()) as { registered: boolean; token: string | null };
    expect(second.status).toBe(200);
    expect(body.registered).toBe(false);
    expect(body.token).toBeNull();

    // Exactly one row, still holding the original credential.
    expect((db.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number }).n).toBe(1);
    const ops = await app.request("/ops", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ops.status).toBe(200);
  });

  it("re-registration refreshes the hostname (or keeps the old one)", async () => {
    await register(MACHINE_A, "laptop-a");
    await register(MACHINE_A, "workstation");
    let row = db
      .prepare("SELECT hostname FROM clients WHERE machine_id = ?")
      .get(MACHINE_A) as { hostname: string | null };
    expect(row.hostname).toBe("workstation");

    // Re-registering WITHOUT a hostname must not blank it (COALESCE).
    await register(MACHINE_A);
    row = db
      .prepare("SELECT hostname FROM clients WHERE machine_id = ?")
      .get(MACHINE_A) as { hostname: string | null };
    expect(row.hostname).toBe("workstation");
  });

  it.each([
    ["15 hex chars", "a1b2c3d4e5f6071"],
    ["17 hex chars", "a1b2c3d4e5f607189"],
    ["uppercase hex", "A1B2C3D4E5F60718"],
    ["non-hex chars", "a1b2c3d4e5f6071g"],
    ["not a string", 12345678901234567],
  ])("rejects a malformed machine_id (%s) with 400", async (_label, machineId) => {
    const res = await app.request("/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine_id: machineId }),
    });
    expect(res.status).toBe(400);
    expect(opsCount()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number }).n).toBe(0);
  });

  it("rejects invalid or non-object JSON bodies with 400", async () => {
    for (const raw of ["not json", "[]", "42", '"str"']) {
      const res = await app.request("/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(res.status, `body ${raw}`).toBe(400);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number }).n).toBe(0);
  });

  it("ignores an over-long hostname (>255 chars)", async () => {
    const res = await register(MACHINE_A, "x".repeat(300));
    expect(res.status).toBe(201);
    const row = db
      .prepare("SELECT hostname FROM clients WHERE machine_id = ?")
      .get(MACHINE_A) as { hostname: string | null };
    expect(row.hostname).toBeNull();
  });

  it("issues distinct tokens per machine", async () => {
    const a = await tokenFor(MACHINE_A);
    const b = await tokenFor(MACHINE_B);
    expect(a).not.toBe(b);
    // Both work independently.
    for (const t of [a, b]) {
      expect(
        (await app.request("/ops", { headers: { authorization: `Bearer ${t}` } })).status,
      ).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Bearer auth
// ---------------------------------------------------------------------------

describe("Bearer auth", () => {
  it("answers 401 when the Authorization header is missing", async () => {
    expect((await app.request("/ops")).status).toBe(401);
    const post = await app.request("/ops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    expect(post.status).toBe(401);
  });

  it.each([
    ["wrong scheme", "Basic abc123"],
    ["empty header", ""],
    ["scheme only, no token", "Bearer"],
    ["trailing space only", "Bearer   "],
    ["no space after scheme", "Bearerabc"],
  ])("answers 401 for a malformed Authorization header (%s)", async (_label, header) => {
    const res = await app.request("/ops", { headers: { authorization: header } });
    expect(res.status).toBe(401);
  });

  it("answers 401 for an unknown (valid-shaped) token", async () => {
    const res = await app.request("/ops", {
      headers: { authorization: `Bearer ${"f".repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a lowercase scheme and tolerates surrounding whitespace", async () => {
    const token = await tokenFor(MACHINE_A);
    const res = await app.request("/ops?since=0", {
      headers: { authorization: `  bearer ${token}  ` },
    });
    expect(res.status).toBe(200);
  });

  it("binds tokens to the pepper — a DB + token are useless across deployments", async () => {
    const other = createOpsRouter(db, { pepper: OTHER_PEPPER, allowOpenEnrollment: true });

    const aToken = await tokenFor(MACHINE_A); // registered under DEFAULT_PEPPER
    expect(
      (await other.request("/ops", { headers: { authorization: `Bearer ${aToken}` } })).status,
    ).toBe(401);

    // A token minted by the other-pepper router works there…
    const res = await other.request("/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine_id: MACHINE_B }),
    });
    const bToken = (await res.json() as { token: string }).token;
    expect(
      (await other.request("/ops", { headers: { authorization: `Bearer ${bToken}` } })).status,
    ).toBe(200);
    // …and fails against the default-pepper router.
    expect(
      (await app.request("/ops", { headers: { authorization: `Bearer ${bToken}` } })).status,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /ops — validation (fail closed)
// ---------------------------------------------------------------------------

describe("POST /ops — validation", () => {
  it("accepts both a bare array and an { ops: [...] } wrapper", async () => {
    const token = await tokenFor(MACHINE_A);

    const bare = await postOps(token, [makeOp({ client_seq: 1 })]);
    expect(bare.status).toBe(200);
    expect(opsCount()).toBe(1);

    const wrapped = await postOps(token, { ops: [makeOp({ gid: "2@x", client_seq: 2 })] });
    expect(wrapped.status).toBe(200);
    expect(opsCount()).toBe(2);
  });

  it("400 when the body is not an array of ops", async () => {
    const token = await tokenFor(MACHINE_A);
    for (const body of [{ nope: 1 }, "str", 42]) {
      const res = await postOps(token, body);
      expect(res.status, `body ${JSON.stringify(body)}`).toBe(400);
    }
    expect(opsCount()).toBe(0);
  });

  it("400 on invalid JSON", async () => {
    const res = await app.request("/ops", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor(MACHINE_A)}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("200 with an empty result for an empty batch", async () => {
    const token = await tokenFor(MACHINE_A);
    for (const body of [[], { ops: [] }]) {
      const res = await postOps(token, body);
      expect(res.status).toBe(200);
      const parsed = (await res.json()) as { machine_id: string; results: unknown[] };
      expect(parsed.machine_id).toBe(MACHINE_A);
      expect(parsed.results).toEqual([]);
    }
  });

  it(`400 when the batch exceeds the ${MAX_OPS_LIMIT}-op cap`, async () => {
    const token = await tokenFor(MACHINE_A);
    const tooMany = Array.from({ length: MAX_OPS_LIMIT + 1 }, (_, i) =>
      makeOp({ gid: `${i + 1}@${MACHINE_A}`, client_seq: i + 1 }),
    );
    const res = await postOps(token, tooMany);
    expect(res.status).toBe(400);
    expect(opsCount()).toBe(0);
  });

  it("rejects a malformed op with its index and stores NOTHING (whole batch)", async () => {
    const token = await tokenFor(MACHINE_A);
    const batch = [
      makeOp({ gid: "1@x", client_seq: 1 }),
      makeOp({ gid: "2@x", client_seq: 2 }),
      { ...makeOp({ gid: "3@x", client_seq: 3 }), kind: "file.rename" }, // unknown kind
    ];
    const res = await postOps(token, batch);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { index: number };
    expect(body.index).toBe(2);
    // Fail closed: the two valid ops in the batch were not half-applied.
    expect(opsCount()).toBe(0);
  });

  it.each([
    ["missing gid", { gid: undefined }],
    ["non-string gid", { gid: 12 }],
    ["gid without @", { gid: "abc" }],
    ["gid with negative id", { gid: "-1@abc" }],
    ["missing kind", { kind: undefined }],
    ["unknown kind", { kind: "file.rename" }],
    ["missing origin", { origin: undefined }],
    ["empty origin", { origin: "" }],
    ["negative base_version", { base_version: -1 }],
    ["fractional base_version", { base_version: 1.5 }],
    ["string base_version", { base_version: "1" }],
    ["missing created_at", { created_at: undefined }],
    ["non-numeric created_at", { created_at: "now" }],
    ["zero client_seq", { client_seq: 0 }],
    ["negative client_seq", { client_seq: -3 }],
  ])("rejects a %s op with 400", async (_label, overrides) => {
    const token = await tokenFor(MACHINE_A);
    const res = await postOps(token, [makeOp(overrides)]);
    expect(res.status).toBe(400);
    expect(opsCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /ops — seq assignment & conflict detection (spec 1.7)
// ---------------------------------------------------------------------------

describe("POST /ops — seq & conflicts", () => {
  it("assigns strictly increasing, server-authoritative seqs", async () => {
    const a = await tokenFor(MACHINE_A);
    const b = await tokenFor(MACHINE_B);

    // B's client clock is SKWED EARLY (2023) — the server must ignore it.
    const rA = await postOps(a, [
      makeOp({ gid: "1@x", client_seq: 1, created_at: T0 }),
      makeOp({ gid: "2@x", client_seq: 2, created_at: T0 + 1 }),
    ]);
    const rB = await postOps(b, [
      makeOp({ gid: "3@x", origin: MACHINE_B, client_seq: 1, created_at: T0 - 5 * 365 * 86_400_000 }),
    ]);

    const resultsA = ((await rA.json()) as { results: Array<{ seq: number }> }).results;
    const resultsB = ((await rB.json()) as { results: Array<{ seq: number }> }).results;
    expect(resultsA.map((r) => r.seq)).toEqual([1, 2]);
    expect(resultsB.map((r) => r.seq)).toEqual([3]);

    // GET /ops serves in seq order (arrival), never by client clock.
    const poll = await app.request("/ops", { headers: { authorization: `Bearer ${a}` } });
    const body = (await poll.json()) as { ops: Array<{ seq: number; created_at: number }> };
    expect(body.ops.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(body.ops[2].created_at).toBeLessThan(body.ops[0].created_at); // skew preserved…
    expect(body.ops[2].seq).toBe(3); // …but ordered by server seq
  });

  it("accepts a create for a fresh gid and an update at the current version", async () => {
    const token = await tokenFor(MACHINE_A);
    const create = await postOps(token, [makeOp({ client_seq: 1 })]);
    const update = await postOps(token, [
      makeOp({ kind: "file.update", base_version: 1, client_seq: 2 }),
    ]);

    const c = ((await create.json()) as { results: Array<{ status: string }> }).results[0];
    const u = ((await update.json()) as { results: Array<{ status: string }> }).results[0];
    expect(c.status).toBe("accepted");
    expect(u.status).toBe("accepted");
  });

  it("flags an update based on a stale base_version as conflict", async () => {
    const token = await tokenFor(MACHINE_A);
    await postOps(token, [makeOp({ client_seq: 1 })]); // v0 -> v1
    await postOps(token, [makeOp({ kind: "file.update", base_version: 1, client_seq: 2 })]); // v1 -> v2

    // This edit was made against v1, but the gid is already at v2.
    const res = await postOps(token, [
      makeOp({ kind: "file.update", base_version: 1, client_seq: 3 }),
    ]);
    const r = ((await res.json()) as { results: Array<{ status: string }> }).results[0];
    expect(r.status).toBe("conflict");
    // The op is APPENDED, not dropped: the log is the authoritative record.
    expect(opsCount("1@deadbeef00001111")).toBe(3);
  });

  it("flags an offline-both-create as conflict for the second writer", async () => {
    const a = await tokenFor(MACHINE_A);
    const b = await tokenFor(MACHINE_B);
    const gid = "42@shared";

    const rA = await postOps(a, [makeOp({ gid, client_seq: 1 })]);
    const rB = await postOps(b, [
      makeOp({ gid, origin: MACHINE_B, client_seq: 1 }),
    ]);

    const statusA = ((await rA.json()) as { results: Array<{ status: string }> }).results[0].status;
    const statusB = ((await rB.json()) as { results: Array<{ status: string }> }).results[0].status;
    expect(statusA).toBe("accepted");
    expect(statusB).toBe("conflict");

    // Both rows are served to other machines; the second carries status.
    const poll = await app.request(`/ops?since=0`, { headers: { authorization: `Bearer ${a}` } });
    const ops = ((await poll.json()) as { ops: Array<{ gid: string; status: string }> }).ops;
    expect(ops.map((o) => o.gid)).toEqual([gid, gid]);
    expect(ops.map((o) => o.status)).toEqual(["accepted", "conflict"]);
  });

  it("keeps the conflict status stable across a retry of the same op", async () => {
    const a = await tokenFor(MACHINE_A);
    const b = await tokenFor(MACHINE_B);
    await postOps(a, [makeOp({ gid: "7@shared" })]);
    await postOps(b, [makeOp({ gid: "7@shared", origin: MACHINE_B, client_seq: 9 })]);

    // B retries the same (origin, client_seq) — lost ACK scenario.
    const retry = await postOps(b, [makeOp({ gid: "7@shared", origin: MACHINE_B, client_seq: 9 })]);
    const r = ((await retry.json()) as { results: Array<Record<string, unknown>> }).results[0];
    expect(r.duplicate).toBe(true);
    expect(r.status).toBe("conflict");
    expect(opsCount("7@shared")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// POST /ops — idempotent retries
// ---------------------------------------------------------------------------

describe("POST /ops — idempotent retries", () => {
  it("a retried (origin, client_seq) returns the ORIGINAL seq with duplicate=true", async () => {
    const token = await tokenFor(MACHINE_A);
    const first = await postOps(token, [makeOp({ client_seq: 7 })]);
    const r1 = ((await first.json()) as { results: Array<Record<string, unknown>> }).results[0];
    expect(r1.duplicate).toBe(false);
    expect(r1.seq).toBe(1);

    const retry = await postOps(token, [makeOp({ client_seq: 7 })]);
    const r2 = ((await retry.json()) as { results: Array<Record<string, unknown>> }).results[0];
    expect(r2.duplicate).toBe(true);
    expect(r2.seq).toBe(1); // the original seq, not a new one
    expect(r2.client_seq).toBe(7);
    expect(opsCount()).toBe(1);
  });

  it("client_seq dedup is scoped per origin (two machines may reuse id 1)", async () => {
    const a = await tokenFor(MACHINE_A);
    const b = await tokenFor(MACHINE_B);
    const rA = await postOps(a, [makeOp({ gid: "1@a", client_seq: 1 })]);
    const rB = await postOps(b, [makeOp({ gid: "1@b", origin: MACHINE_B, client_seq: 1 })]);

    const aRes = ((await rA.json()) as { results: Array<Record<string, unknown>> }).results[0];
    const bRes = ((await rB.json()) as { results: Array<Record<string, unknown>> }).results[0];
    expect(aRes.duplicate).toBe(false);
    expect(bRes.duplicate).toBe(false);
    expect(opsCount()).toBe(2);
  });

  it("ops without client_seq are never deduplicated", async () => {
    const token = await tokenFor(MACHINE_A);
    await postOps(token, [makeOp()]);
    await postOps(token, [makeOp()]);
    expect(opsCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /ops — polling
// ---------------------------------------------------------------------------

describe("GET /ops — polling", () => {
  it("serves seq > since in seq order with a decoded payload", async () => {
    const token = await tokenFor(MACHINE_A);
    const payload = { path: "/kb/a.md", content: "hello", nested: { n: 1 } };
    await postOps(token, [
      makeOp({ payload, client_seq: 1 }),
      makeOp({ kind: "file.update", base_version: 1, payload: { content: "v2" }, client_seq: 2 }),
    ]);

    const res = await app.request("/ops?since=0", {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { ops: Array<Record<string, unknown>>; next: number };

    expect(res.status).toBe(200);
    expect(body.ops.map((o) => o.seq)).toEqual([1, 2]);
    expect(body.ops[0].payload).toEqual(payload); // decoded, not a JSON string
    expect(body.ops[1].payload).toEqual({ content: "v2" });
    expect(body.next).toBe(2);
    for (const o of body.ops) {
      expect(typeof o.gid).toBe("string");
      expect(typeof o.kind).toBe("string");
      expect(typeof o.origin).toBe("string");
      expect(typeof o.created_at).toBe("number");
      expect(typeof o.received_at).toBe("number");
      expect(o.status).toBe("accepted");
    }
    expect(body.ops[0].client_seq).toBe(1);
  });

  it("returns an empty batch with next=since when caught up", async () => {
    const token = await tokenFor(MACHINE_A);
    const res = await app.request("/ops?since=42", {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { ops: unknown[]; next: number };
    expect(res.status).toBe(200);
    expect(body.ops).toEqual([]);
    expect(body.next).toBe(42);
  });

  it("paginates with limit, advancing the cursor to exhaustion", async () => {
    const token = await tokenFor(MACHINE_A);
    await postOps(token, [
      makeOp({ gid: "1@x", client_seq: 1 }),
      makeOp({ gid: "2@x", client_seq: 2 }),
      makeOp({ gid: "3@x", client_seq: 3 }),
      makeOp({ gid: "4@x", client_seq: 4 }),
      makeOp({ gid: "5@x", client_seq: 5 }),
    ]);

    let since = 0;
    const seen: number[] = [];
    for (let page = 0; page < 5; page++) {
      const res = await app.request(`/ops?since=${since}&limit=2`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { ops: Array<{ seq: number }>; next: number };
      expect(res.status).toBe(200);
      expect(body.ops.length).toBeLessThanOrEqual(2);
      seen.push(...body.ops.map((o) => o.seq));
      since = body.next;
      if (body.ops.length === 0) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it(`caps limit at ${MAX_OPS_LIMIT}`, async () => {
    const token = await tokenFor(MACHINE_A);
    // POST batches are also capped at MAX_OPS_LIMIT, so two posts: 1000 + 1.
    await postOps(
      token,
      Array.from({ length: MAX_OPS_LIMIT }, (_, i) => makeOp({ gid: `${i + 1}@x`, client_seq: i + 1 })),
    );
    await postOps(token, [makeOp({ gid: "99999@x", client_seq: MAX_OPS_LIMIT + 1 })]);

    const res = await app.request("/ops?since=0&limit=999999", {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { ops: Array<{ seq: number }>; next: number };
    expect(body.ops.length).toBe(MAX_OPS_LIMIT);
    expect(body.next).toBe(MAX_OPS_LIMIT);
  });

  it(`uses the default limit of ${DEFAULT_OPS_LIMIT}`, async () => {
    const token = await tokenFor(MACHINE_A);
    await postOps(
      token,
      Array.from({ length: DEFAULT_OPS_LIMIT }, (_, i) => makeOp({ gid: `${i + 1}@x`, client_seq: i + 1 })),
    );
    await postOps(token, [makeOp({ gid: "99999@x", client_seq: DEFAULT_OPS_LIMIT + 1 })]);

    const res = await app.request("/ops", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { ops: unknown[]; next: number };
    expect(body.ops.length).toBe(DEFAULT_OPS_LIMIT);
    expect(body.next).toBe(DEFAULT_OPS_LIMIT);
  });

  it.each([
    ["non-integer since", "since=abc"],
    ["negative since", "since=-1"],
    ["fractional since", "since=1.5"],
    ["empty since", "since="],
    ["zero limit", "limit=0"],
    ["non-integer limit", "limit=abc"],
    ["negative limit", "limit=-4"],
    ["empty limit", "limit="],
  ])("400 on malformed query params (%s)", async (_label, qs) => {
    const token = await tokenFor(MACHINE_A);
    const res = await app.request(`/ops?${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it("advances the client's last_seen_at on each authenticated poll", async () => {
    const token = await tokenFor(MACHINE_A);
    const seen = () =>
      (db.prepare("SELECT last_seen_at FROM clients WHERE machine_id = ?").get(MACHINE_A) as {
        last_seen_at: number;
      }).last_seen_at;

    const before = seen();
    await new Promise((r) => setTimeout(r, 15));
    const res = await app.request("/ops?since=0", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(seen()).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Exported helpers (unit)
// ---------------------------------------------------------------------------

describe("parseGetOpsParams", () => {
  it("applies defaults (since=0, limit=200)", () => {
    expect(parseGetOpsParams(undefined, undefined)).toEqual({ since: 0, limit: DEFAULT_OPS_LIMIT });
  });

  it("parses explicit values", () => {
    expect(parseGetOpsParams("5", "10")).toEqual({ since: 5, limit: 10 });
    expect(parseGetOpsParams("0", "1")).toEqual({ since: 0, limit: 1 });
  });

  it("honors a custom default; explicit limit is capped only at the hard max", () => {
    // Absent param -> the deployment's configured default.
    expect(parseGetOpsParams(undefined, undefined, 50)).toEqual({ since: 0, limit: 50 });
    // Explicit param -> client's choice, bounded only by the hard cap (NOT the
    // deployment default, which is just the fallback for an absent param).
    expect(parseGetOpsParams(undefined, "999999")).toEqual({ since: 0, limit: MAX_OPS_LIMIT });
    expect(parseGetOpsParams(undefined, "999999", 50)).toEqual({ since: 0, limit: MAX_OPS_LIMIT });
    // An explicit limit below the cap passes through untouched.
    expect(parseGetOpsParams(undefined, "10", 50)).toEqual({ since: 0, limit: 10 });
  });

  it("rejects malformed values with null", () => {
    for (const bad of ["abc", "-1", "1.5", ""]) {
      expect(parseGetOpsParams(bad, undefined), `since=${bad}`).toBeNull();
    }
    for (const bad of ["abc", "0", "-4", "2.5", ""]) {
      expect(parseGetOpsParams(undefined, bad), `limit=${bad}`).toBeNull();
    }
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer   abc123  ")).toBe("abc123");
    expect(extractBearerToken("BEARER abc123")).toBe("abc123");
  });

  it("returns null for anything malformed", () => {
    for (const bad of [undefined, "", "Basic abc", "Bearer", "Bearer   ", "Bearerabc", "Token abc"]) {
      expect(extractBearerToken(bad), `header=${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("validateIncomingOp", () => {
  it("accepts a minimal valid op and canonicalizes its payload", () => {
    const v = validateIncomingOp({
      gid: "1@abc",
      kind: "file.create",
      origin: MACHINE_A,
      base_version: null,
      payload: { a: 1, b: "x" },
      created_at: T0,
    });
    expect(v).not.toBeNull();
    expect(v!.client_seq).toBeNull(); // omitted -> null
    expect(v!.payloadJson).toBe(JSON.stringify({ a: 1, b: "x" }));
  });

  it("accepts a null payload (stored as the 4 chars 'null')", () => {
    const v = validateIncomingOp({
      gid: "1@abc",
      kind: "tag.set",
      origin: MACHINE_A,
      base_version: 3,
      payload: null,
      created_at: T0,
      client_seq: 5,
    });
    expect(v).not.toBeNull();
    expect(v!.base_version).toBe(3);
    expect(v!.client_seq).toBe(5);
    expect(v!.payloadJson).toBe("null");
  });

  it("rejects every malformed field shape", () => {
    const good = {
      gid: "1@abc",
      kind: "file.create",
      origin: MACHINE_A,
      base_version: null,
      payload: {},
      created_at: T0,
    };
    const bads: Array<Record<string, unknown>> = [
      {},
      { ...good, gid: "abc" },
      { ...good, gid: "1@" },
      { ...good, gid: "-1@abc" },
      { ...good, kind: "file.rename" },
      { ...good, origin: "" },
      { ...good, base_version: -1 },
      { ...good, base_version: 1.5 },
      { ...good, base_version: "1" },
      { ...good, created_at: "now" },
      { ...good, client_seq: 0 },
      { ...good, client_seq: -2 },
      { ...good, client_seq: "7" },
    ];
    for (const bad of bads) {
      expect(validateIncomingOp(bad), JSON.stringify(bad)).toBeNull();
    }
    // Non-objects are rejected outright.
    expect(validateIncomingOp(null)).toBeNull();
    expect(validateIncomingOp([])).toBeNull();
    expect(validateIncomingOp("op")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enrollment secret
// ---------------------------------------------------------------------------

describe("POST /clients enrollment", () => {
  const post = (r: ReturnType<typeof createOpsRouter>, body: unknown, headers: Record<string, string> = {}) =>
    r.request("/clients", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("refuses new machines when no secret is configured and open mode is off", async () => {
    const closed = createOpsRouter(db);
    const res = await post(closed, { machine_id: MACHINE_A });
    expect(res.status).toBe(403);
    expect(opsCount()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number }).n).toBe(0);
  });

  it("requires the configured secret (header or body) and rejects a wrong one", async () => {
    const r = createOpsRouter(db, { enrollSecret: "s3cret" });
    expect((await post(r, { machine_id: MACHINE_A })).status).toBe(403);
    expect((await post(r, { machine_id: MACHINE_A }, { "x-enroll-secret": "nope" })).status).toBe(403);
    expect((await post(r, { machine_id: MACHINE_A }, { "x-enroll-secret": "s3cret" })).status).toBe(201);
    expect((await post(r, { machine_id: MACHINE_B, enroll_secret: "s3cret" })).status).toBe(201);
    expect((await post(r, { machine_id: "0123456789abcdef", enroll_secret: "bad" })).status).toBe(403);
  });

  it("a secret takes precedence over open mode", async () => {
    const r = createOpsRouter(db, { enrollSecret: "s3cret", allowOpenEnrollment: true });
    expect((await post(r, { machine_id: MACHINE_A })).status).toBe(403);
  });

  it("re-registration without the secret is 403 and does not change the hostname", async () => {
    await tokenFor(MACHINE_A);
    db.prepare("UPDATE clients SET hostname = 'original' WHERE machine_id = ?").run(MACHINE_A);
    const r = createOpsRouter(db, { enrollSecret: "s3cret" });
    const res = await post(r, { machine_id: MACHINE_A, hostname: "pwned" });
    expect(res.status).toBe(403);
    expect((db.prepare("SELECT hostname FROM clients WHERE machine_id = ?").get(MACHINE_A) as { hostname: string }).hostname).toBe("original");
  });

  it("answers identically for known and unknown machine ids without the secret", async () => {
    await tokenFor(MACHINE_A);
    const r = createOpsRouter(db, { enrollSecret: "s3cret" });
    const known = await post(r, { machine_id: MACHINE_A });
    const unknown = await post(r, { machine_id: "0123456789abcdef" });
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("re-registration with the secret refreshes the hostname and returns no token", async () => {
    await tokenFor(MACHINE_A);
    const r = createOpsRouter(db, { enrollSecret: "s3cret" });
    const res = await post(r, { machine_id: MACHINE_A, hostname: "renamed" }, { "x-enroll-secret": "s3cret" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: unknown }).token).toBeNull();
    expect((db.prepare("SELECT hostname FROM clients WHERE machine_id = ?").get(MACHINE_A) as { hostname: string }).hostname).toBe("renamed");
  });
});

// ---------------------------------------------------------------------------
// Origin binding
// ---------------------------------------------------------------------------

describe("POST /ops origin binding", () => {
  it("rejects the whole batch with 403 when any op origin is not the authenticated machine", async () => {
    const a = await tokenFor(MACHINE_A);
    await tokenFor(MACHINE_B);
    const res = await postOps(a, [
      makeOp({ gid: "1@x", client_seq: 1 }),
      makeOp({ gid: "2@x", origin: MACHINE_B, client_seq: 1 }),
    ]);
    expect(res.status).toBe(403);
    expect(opsCount()).toBe(0);
  });

  it("cannot pre-claim another machine's (origin, client_seq) slots", async () => {
    const a = await tokenFor(MACHINE_A);
    await postOps(a, [makeOp({ gid: "1@x", origin: MACHINE_B, client_seq: 1 })]);
    expect(opsCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gid versions
// ---------------------------------------------------------------------------

describe("gid_version / version", () => {
  it("POST results carry the gid version right after each op, in order", async () => {
    const a = await tokenFor(MACHINE_A);
    const res = await postOps(a, [
      makeOp({ gid: "1@x", base_version: null, client_seq: 1 }),
      makeOp({ gid: "2@x", base_version: null, client_seq: 2 }),
      makeOp({ gid: "1@x", kind: "file.update", base_version: 1, client_seq: 3 }),
    ]);
    const { results } = (await res.json()) as { results: Array<{ version: number; status: string }> };
    expect(results.map((r) => r.version)).toEqual([1, 1, 2]);
    expect(results.every((r) => r.status === "accepted")).toBe(true);
  });

  it("a conflicting op still advances the version", async () => {
    const a = await tokenFor(MACHINE_A);
    await postOps(a, [makeOp({ gid: "1@x", base_version: null, client_seq: 1 })]);
    const res = await postOps(a, [makeOp({ gid: "1@x", kind: "file.update", base_version: 0, client_seq: 2 })]);
    const r = ((await res.json()) as { results: Array<{ version: number; status: string }> }).results[0];
    expect(r.status).toBe("conflict");
    expect(r.version).toBe(2);
  });

  it("a duplicate returns the version at the ORIGINAL seq, not the current count", async () => {
    const a = await tokenFor(MACHINE_A);
    await postOps(a, [makeOp({ gid: "1@x", base_version: null, client_seq: 1 })]);
    await postOps(a, [makeOp({ gid: "1@x", kind: "file.update", base_version: 1, client_seq: 2 })]);
    const res = await postOps(a, [makeOp({ gid: "1@x", base_version: null, client_seq: 1 })]);
    const r = ((await res.json()) as { results: Array<{ version: number; duplicate: boolean }> }).results[0];
    expect(r.duplicate).toBe(true);
    expect(r.version).toBe(1);
  });

  it("GET /ops serves gid_version counted over ALL history, even when a page starts mid-history", async () => {
    const a = await tokenFor(MACHINE_A);
    const b = await tokenFor(MACHINE_B);
    await postOps(a, [
      makeOp({ gid: "1@x", base_version: null, client_seq: 1 }),
      makeOp({ gid: "1@x", kind: "file.update", base_version: 1, client_seq: 2 }),
      makeOp({ gid: "2@x", base_version: null, client_seq: 3 }),
    ]);
    await postOps(b, [makeOp({ gid: "1@x", kind: "file.update", origin: MACHINE_B, base_version: 2, client_seq: 1 })]);

    const all = (await (await app.request("/ops?since=0&limit=10", { headers: { authorization: `Bearer ${a}` } })).json()) as {
      ops: Array<{ seq: number; gid: string; gid_version: number }>;
    };
    expect(all.ops.map((o) => o.gid_version)).toEqual([1, 2, 1, 3]);

    const page = (await (await app.request("/ops?since=2&limit=10", { headers: { authorization: `Bearer ${a}` } })).json()) as {
      ops: Array<{ gid: string; gid_version: number }>;
    };
    expect(page.ops.map((o) => [o.gid, o.gid_version])).toEqual([["2@x", 1], ["1@x", 3]]);
  });
});

// ---------------------------------------------------------------------------
// Startup guard
// ---------------------------------------------------------------------------

describe("default pepper startup guard", () => {
  it("classifies loopback hosts", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "127.1.2.3"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.5", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("refuses the default pepper on a non-loopback bind unless overridden", () => {
    expect(defaultPepperRefusal(true, "0.0.0.0", {})).toMatch(/KXTA_STORAGE_PEPPER/);
    expect(defaultPepperRefusal(true, "0.0.0.0", { KXTA_STORAGE_ALLOW_DEFAULT_PEPPER: "1" })).toBeNull();
    expect(defaultPepperRefusal(true, "127.0.0.1", {})).toBeNull();
    expect(defaultPepperRefusal(false, "0.0.0.0", {})).toBeNull();
  });
});
