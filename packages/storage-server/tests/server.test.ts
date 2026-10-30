/**
 * Brain host ops, auth and startup tests.
 *
 * Routes run through Hono's in-process client against a real in-memory SQLite database loaded with the
 * real schema, so the schema and the routes are tested exactly as deployed.
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
import { createBrainsRouter } from "../src/routes/brains.js";
import { DEFAULT_PEPPER, hashToken } from "../src/auth.js";
import { generateShareId, formatShareId } from "../src/shareid.js";
import { VERSION } from "../src/index.js";
import { defaultPepperRefusal, isLoopbackHost } from "../src/server.js";
import { Hono } from "hono";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(here, "..", "src", "db", "schema.sql"), "utf-8");

const MACHINE_A = "a1b2c3d4e5f60718";
const MACHINE_B = "0f1e2d3c4b5a6978";
const OTHER_PEPPER = "unit-test-pepper-2";
const T0 = 1_700_000_000_000;

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

let db: Database.Database;
let app: Hono;
let shareId: string;

beforeEach(() => {
  db = freshDb();
  app = new Hono();
  app.route("/", createOpsRouter(db));
  app.route("/", createBrainsRouter(db, { allowOpenCreate: true }));
  shareId = formatShareId(generateShareId());
});

async function join(machineId: string, share: string = shareId, extra: Record<string, unknown> = {}) {
  return app.request("/brains/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ share_id: share, machine_id: machineId, hostname: "laptop", ...extra }),
  });
}

/** Join (creating the brain on first use) and return the machine's token. */
async function tokenFor(machineId: string = MACHINE_A, share: string = shareId): Promise<string> {
  const res = await join(machineId, share);
  const body = (await res.json()) as { token: string | null };
  if (typeof body.token !== "string") throw new Error(`join(${machineId}) failed: ${res.status} ${JSON.stringify(body)}`);
  return body.token;
}

async function postOps(token: string, body: unknown) {
  return app.request("/ops", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getOps(token: string, query = "") {
  return app.request(`/ops${query}`, { headers: { authorization: `Bearer ${token}` } });
}

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

function opsCount(gid?: string): number {
  const row = gid
    ? db.prepare("SELECT COUNT(*) AS n FROM ops WHERE gid = ?").get(gid)
    : db.prepare("SELECT COUNT(*) AS n FROM ops").get();
  return (row as { n: number }).n;
}

describe("GET /health", () => {
  it("answers without auth and names the service", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; version: string };
    expect(body.service).toBe("kontexta-brain-host");
    expect(body.version).toBe(VERSION);
  });
});

describe("Bearer auth", () => {
  it("rejects missing, malformed and unknown tokens with 401", async () => {
    expect((await app.request("/ops")).status).toBe(401);
    expect((await app.request("/ops", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    expect((await getOps("not-a-token")).status).toBe(401);
  });

  it("binds token hashes to the deployment pepper", async () => {
    const token = await tokenFor();
    const other = new Hono();
    other.route("/", createOpsRouter(db, { pepper: OTHER_PEPPER }));
    expect((await other.request("/ops", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(hashToken(token, DEFAULT_PEPPER)).not.toBe(hashToken(token, OTHER_PEPPER));
  });
});

describe("POST /ops", () => {
  it("assigns server seq in order and returns the accepted version", async () => {
    const t = await tokenFor();
    const res = await postOps(t, [makeOp({ client_seq: 1 }), makeOp({ gid: "2@deadbeef00001111", client_seq: 2 })]);
    const { results } = (await res.json()) as { results: Array<{ seq: number; status: string; version: number }> };
    expect(results.map((r) => [r.seq, r.status, r.version])).toEqual([[1, "accepted", 1], [2, "accepted", 1]]);
  });

  it("flags a stale base_version as conflict without raising the version", async () => {
    const t = await tokenFor();
    await postOps(t, [makeOp({ client_seq: 1 })]);
    await postOps(t, [makeOp({ kind: "file.update", base_version: 1, client_seq: 2 })]);
    const res = await postOps(t, [makeOp({ kind: "file.update", base_version: 1, client_seq: 3 })]);
    const { results } = (await res.json()) as { results: Array<{ status: string; version: number }> };
    expect(results[0]).toMatchObject({ status: "conflict", version: 2 });
  });

  it("flags a later op of the same record in a batch when an earlier one lost", async () => {
    const t = await tokenFor();
    await postOps(t, [makeOp({ client_seq: 1 })]);
    await postOps(t, [makeOp({ kind: "file.update", base_version: 1, client_seq: 2 })]);
    const res = await postOps(t, [
      makeOp({ kind: "file.update", base_version: 1, client_seq: 3 }),
      makeOp({ kind: "file.update", base_version: 2, client_seq: 4 }),
    ]);
    const { results } = (await res.json()) as { results: Array<{ status: string }> };
    expect(results.map((r) => r.status)).toEqual(["conflict", "conflict"]);
  });

  it("a tag.set does not raise the content version of the same gid", async () => {
    const t = await tokenFor();
    await postOps(t, [makeOp({ client_seq: 1 })]);
    await postOps(t, [makeOp({ kind: "tag.set", base_version: 0, payload: { tags: ["a"] }, client_seq: 2 })]);
    const res = await postOps(t, [makeOp({ kind: "file.update", base_version: 1, client_seq: 3 })]);
    const { results } = (await res.json()) as { results: Array<{ status: string }> };
    expect(results[0].status).toBe("accepted");
  });

  it("rejects the whole batch with 403 when an op origin is not the authenticated machine", async () => {
    const a = await tokenFor(MACHINE_A);
    const res = await postOps(a, [makeOp({ client_seq: 1 }), makeOp({ gid: "2@x", origin: MACHINE_B, client_seq: 2 })]);
    expect(res.status).toBe(403);
    expect(opsCount()).toBe(0);
  });

  it("returns the original seq and version for a retried (origin, client_seq)", async () => {
    const t = await tokenFor();
    const first = (await (await postOps(t, [makeOp({ client_seq: 7 })])).json()) as { results: Array<{ seq: number }> };
    const again = (await (await postOps(t, [makeOp({ client_seq: 7 })])).json()) as { results: Array<{ seq: number; duplicate: boolean; version: number }> };
    expect(again.results[0]).toMatchObject({ seq: first.results[0].seq, duplicate: true, version: 1 });
    expect(opsCount()).toBe(1);
  });

  it("rejects a malformed op with 400 and stores nothing", async () => {
    const t = await tokenFor();
    expect((await postOps(t, [makeOp(), makeOp({ kind: "tag.add" })])).status).toBe(400);
    expect(opsCount()).toBe(0);
  });
});

describe("GET /ops", () => {
  it("pages by cursor and carries gid_version per row", async () => {
    const t = await tokenFor();
    await postOps(t, [makeOp({ client_seq: 1 }), makeOp({ kind: "file.update", base_version: 1, client_seq: 2 })]);
    const body = (await (await getOps(t, "?since=0&limit=10")).json()) as { ops: Array<{ seq: number; gid_version: number }>; next: number };
    expect(body.ops.map((o) => o.gid_version)).toEqual([1, 2]);
    expect(body.next).toBe(2);
    expect(((await (await getOps(t, "?since=2")).json()) as { ops: unknown[] }).ops).toEqual([]);
  });

  it("acked= updates the machine's acked_seq", async () => {
    const t = await tokenFor();
    await getOps(t, "?since=0&acked=9");
    expect((db.prepare("SELECT acked_seq FROM clients").get() as { acked_seq: number }).acked_seq).toBe(9);
  });

  it("400s on malformed since/limit/acked", async () => {
    const t = await tokenFor();
    for (const q of ["?since=-1", "?limit=0", "?since=x", "?acked=-2"]) expect((await getOps(t, q)).status).toBe(400);
  });
});

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


describe("default pepper startup guard", () => {
  it("classifies loopback hosts", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "127.1.2.3"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.5", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("refuses the default pepper on a non-loopback bind unless overridden", () => {
    expect(defaultPepperRefusal(true, "0.0.0.0", {})).toMatch(/KXTA_BRAIN_PEPPER/);
    expect(defaultPepperRefusal(true, "0.0.0.0", { KXTA_BRAIN_ALLOW_DEFAULT_PEPPER: "1" })).toBeNull();
    expect(defaultPepperRefusal(true, "127.0.0.1", {})).toBeNull();
    expect(defaultPepperRefusal(false, "0.0.0.0", {})).toBeNull();
  });
});
