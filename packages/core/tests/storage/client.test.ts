/**
 * M68 — Endpoint client + adaptive short-polling sync loop (src/storage/client.ts).
 *
 * Contract pinned here (spec 1.6–1.7):
 *
 *   CONFIG — the connection lives in `settings` (migration 015). `connectEndpoint`
 *     VERIFIES the server (health + token probe) BEFORE persisting; a failed
 *     probe persists nothing. `disconnectEndpoint` deletes the credentials and
 *     the loop goes dormant on its next tick (config is re-read every tick).
 *
 *   PUSH — due outbox rows drain in local-seq order; `client_seq` = the outbox
 *     id (idempotent retries); `base_version` is rewritten at send time from
 *     the local per-gid high-water mark (the server's spec-1.7 client
 *     protocol); success acks with the server seq, failure marks `failed` with
 *     attempt counter + exponential backoff (1 s → 5 min); orphaned `sent`
 *     rows (crash mid-POST) are re-queued.
 *
 *   PULL — pages GET /ops until caught up, applies each op via applyRemoteOp,
 *     skips own-origin ops, advances the monotonic cursor only after a clean
 *     page, and FAILS CLOSED (no cursor advance) on a malformed/unappliable op.
 *
 *   LOOP — process singleton; active cadence (15 s default) while active, idle
 *     cadence (60 s) otherwise, exponential backoff on failure (resets on
 *     recovery), live config re-read, unref'd timers.
 *
 * No sockets: every request goes through an injected fake fetch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { resetDataDirCache } from "../../src/util/paths.js";
import { enqueueOp, markAcked, markSent } from "../../src/storage/outbox.js";
import {
  ACTIVE_POLL_INTERVAL_DEFAULT_MS,
  IDLE_POLL_INTERVAL_DEFAULT_MS,
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  MAX_BATCH_SIZE,
  MAX_APPLY_ATTEMPTS,
  backoffDelay,
  normalizeBaseUrl,
  readEndpointConfig,
  connectEndpoint,
  disconnectEndpoint,
  pushOutbox,
  pullRemoteOps,
  getSyncCursor,
  advanceSyncCursor,
  startSyncLoop,
  stopSyncLoop,
  getSyncLoop,
  syncLoop,
} from "../../src/storage/client.js";
import type { Op } from "../../src/storage/op.js";
import type { Database } from "better-sqlite3";

const REMOTE_MID = "aaaaaaaaaaaaaaaa";
const REMOTE_GID = (n: number): string => `${n}@${REMOTE_MID}`;

/** A well-formed local op; `overrides` perturbs a single field. */
function validOp(n: number, overrides: Record<string, unknown> = {}, mid: string = MID): Op {
  return {
    gid: `${n}@${mid}`,
    kind: "file.update",
    origin: mid,
    base_version: 0,
    payload: { path: `/kb/a/f${n}.md`, content: `content-${n}` },
    created_at: 1_700_000_000_000 + n,
    ...overrides,
  } as unknown as Op;
}

/** This machine's id (seeded 16-hex by migration 013; read once per test). */
let MID: string;

function machineIdOf(db: Database): string {
  return (
    (db.prepare("SELECT value FROM settings WHERE key = 'machine_id'").get() as { value: string })
      .value
  );
}

function setEndpoint(db: Database, url = "https://store.test", token = "tok-1"): void {
  const up = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  );
  up.run("endpoint_url", url);
  up.run("endpoint_token", token);
}

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}
type FakeHandler = (
  url: string,
  init?: RequestInit,
) => { status?: number; body?: unknown; raw?: string } | Promise<{ status?: number; body?: unknown; raw?: string }>;

function fakeFetch(handler: FakeHandler): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const out = await handler(url, init);
    const status = out.status ?? 200;
    const text = out.raw ?? (out.body === undefined ? "" : JSON.stringify(out.body));
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function outboxRow(db: Database, id: number): {
  status: string;
  attempts: number;
  server_seq: number | null;
  next_attempt_at: number | null;
  last_error: string | null;
} {
  return db.prepare("SELECT status, attempts, server_seq, next_attempt_at, last_error FROM outbox WHERE id = ?").get(id) as never;
}

describe("storage client (M68)", () => {
  let testDir: string;
  let db: Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-client-test-"));
    process.env.KONTEXTA_DATA_DIR = testDir;
    resetDataDirCache();
    db = createDatabase(join(testDir, "test.db"));
    MID = machineIdOf(db);
    stopSyncLoop(); // paranoia: never carry a loop across tests
  });

  afterEach(() => {
    stopSyncLoop();
    delete process.env.KONTEXTA_DATA_DIR;
    resetDataDirCache();
    closeDatabase();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  describe("backoffDelay (spec 1.6 exponential backoff)", () => {
    it("doubles from the initial delay up to the 5-minute ceiling", () => {
      const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000];
      for (let i = 0; i < expected.length; i++) {
        expect(backoffDelay(i), `failure ${i}`).toBe(expected[i]);
      }
      // 256 s is the last value under the cap; 512 s is clamped to 5 min.
      expect(backoffDelay(9)).toBe(BACKOFF_MAX_MS);
      expect(backoffDelay(10)).toBe(BACKOFF_MAX_MS);
      expect(backoffDelay(100)).toBe(BACKOFF_MAX_MS);
    });

    it("honors custom initial/ceiling and floors negative failure counts", () => {
      expect(backoffDelay(0, 10, 100)).toBe(10);
      expect(backoffDelay(1, 10, 100)).toBe(20);
      expect(backoffDelay(2, 10, 100)).toBe(40);
      expect(backoffDelay(4, 10, 100)).toBe(100); // capped
      expect(backoffDelay(-3)).toBe(BACKOFF_INITIAL_MS);
    });

    it("exports the spec-1.6 defaults (15 s / 60 s / 1 s / 5 min)", () => {
      expect(ACTIVE_POLL_INTERVAL_DEFAULT_MS).toBe(15_000);
      expect(IDLE_POLL_INTERVAL_DEFAULT_MS).toBe(60_000);
      expect(BACKOFF_INITIAL_MS).toBe(1_000);
      expect(BACKOFF_MAX_MS).toBe(300_000);
    });
  });

  describe("normalizeBaseUrl", () => {
    it("trims and strips trailing slashes", () => {
      expect(normalizeBaseUrl("https://store.example.com/")).toBe("https://store.example.com");
      expect(normalizeBaseUrl("  https://store.example.com/a//  ")).toBe("https://store.example.com/a");
      expect(normalizeBaseUrl("http://localhost:23010/x/")).toBe("http://localhost:23010/x");
    });

    it("rejects non-http(s) and malformed URLs (throws)", () => {
      expect(() => normalizeBaseUrl("ftp://store.example.com")).toThrow(/protocol/);
      expect(() => normalizeBaseUrl("not a url")).toThrow(/valid URL/);
      expect(() => normalizeBaseUrl("")).toThrow(/non-empty/);
    });
  });

  describe("readEndpointConfig (migration 015 settings)", () => {
    it("reports disconnected with the spec-1.6 cadence defaults on a fresh vault", () => {
      const cfg = readEndpointConfig(db);
      expect(cfg.connected).toBe(false);
      expect(cfg.url).toBe("");
      expect(cfg.token).toBe("");
      expect(cfg.activePollIntervalMs).toBe(15_000);
      expect(cfg.idlePollIntervalMs).toBe(60_000);
    });

    it("reports connected only when BOTH credentials are non-empty", () => {
      setEndpoint(db);
      expect(readEndpointConfig(db).connected).toBe(true);
      expect(readEndpointConfig(db).url).toBe("https://store.test");
      expect(readEndpointConfig(db).token).toBe("tok-1");

      db.prepare("DELETE FROM settings WHERE key = 'endpoint_token'").run();
      expect(readEndpointConfig(db).connected).toBe(false);

      db.prepare("DELETE FROM settings WHERE key = 'endpoint_url'").run();
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('endpoint_token', 'tok-1', datetime('now'))").run();
      expect(readEndpointConfig(db).connected).toBe(false); // token alone is not a connection
    });

    it("falls back to defaults for malformed poll intervals (never wedges the loop)", () => {
      const up = db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      );
      up.run("poll_active_interval_ms", "not-a-number");
      up.run("poll_idle_interval_ms", "250"); // below the 1 s floor
      const cfg = readEndpointConfig(db);
      expect(cfg.activePollIntervalMs).toBe(15_000);
      expect(cfg.idlePollIntervalMs).toBe(60_000);

      up.run("poll_active_interval_ms", "7000");
      up.run("poll_idle_interval_ms", "120000");
      expect(readEndpointConfig(db).activePollIntervalMs).toBe(7_000);
      expect(readEndpointConfig(db).idlePollIntervalMs).toBe(120_000);
    });
  });

  describe("connectEndpoint (verify-then-persist)", () => {
    it("persists the normalized URL + token after a passing health + token probe", async () => {
      const { fetch, calls } = fakeFetch((url) => {
        if (url.endsWith("/health")) return { status: 200, body: { status: "ok", service: "kontexta-storage-server" } };
        if (url.includes("/ops?since=0&limit=1")) return { status: 200, body: { ops: [], next: 0 } };
        return { status: 404 };
      });
      await connectEndpoint(db, "https://store.example.com///", "  tok-abc  ", { fetchImpl: fetch });

      const cfg = readEndpointConfig(db);
      expect(cfg.connected).toBe(true);
      expect(cfg.url).toBe("https://store.example.com");
      expect(cfg.token).toBe("tok-abc");
      // Exactly two probes: health (unauthenticated) then the token probe (Bearer).
      expect(calls.length).toBe(2);
      expect(calls[0].url).toBe("https://store.example.com/health");
      expect(calls[1].url).toBe("https://store.example.com/ops?since=0&limit=1");
      expect((calls[1].init?.headers as Record<string, string>).authorization).toBe("Bearer tok-abc");
    });

    it("persists NOTHING when the health check fails (non-200)", async () => {
      const { fetch } = fakeFetch(() => ({ status: 503, raw: "unavailable" }));
      await expect(connectEndpoint(db, "https://store.example.com", "tok", { fetchImpl: fetch }))
        .rejects.toThrow(/health check failed \(HTTP 503\)/);
      expect(readEndpointConfig(db).connected).toBe(false);
    });

    it("persists NOTHING when the server is not a kontexta-storage-server", async () => {
      const { fetch } = fakeFetch((url) =>
        url.endsWith("/health") ? { status: 200, body: { status: "ok", service: "some-other-service" } } : { status: 200, body: {} },
      );
      await expect(connectEndpoint(db, "https://store.example.com", "tok", { fetchImpl: fetch }))
        .rejects.toThrow(/unexpected service/);
      expect(readEndpointConfig(db).connected).toBe(false);
    });

    it("persists NOTHING when the server rejects the token (401)", async () => {
      const { fetch } = fakeFetch((url) =>
        url.endsWith("/health") ? { status: 200, body: { service: "kontexta-storage-server" } } : { status: 401, body: { error: "unauthorized" } },
      );
      await expect(connectEndpoint(db, "https://store.example.com", "bad-token", { fetchImpl: fetch }))
        .rejects.toThrow(/rejected the token/);
      expect(readEndpointConfig(db).connected).toBe(false);
    });

    it("persists NOTHING when the network is unreachable", async () => {
      const { fetch } = fakeFetch(() => {
        throw new TypeError("fetch failed");
      });
      await expect(connectEndpoint(db, "https://store.example.com", "tok", { fetchImpl: fetch }))
        .rejects.toThrow();
      expect(readEndpointConfig(db).connected).toBe(false);
    });

    it("rejects an empty token before touching the network", async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: {} }));
      await expect(connectEndpoint(db, "https://store.example.com", "   ", { fetchImpl: fetch }))
        .rejects.toThrow(/token must be a non-empty/);
      expect(calls.length).toBe(0);
    });

    it("overwrites a previous connection when re-connecting elsewhere", async () => {
      setEndpoint(db, "https://old.example.com", "old-token");
      const { fetch } = fakeFetch((url) =>
        url.endsWith("/health") ? { status: 200, body: { service: "kontexta-storage-server" } } : { status: 200, body: { ops: [], next: 0 } },
      );
      await connectEndpoint(db, "https://new.example.com/", "new-token", { fetchImpl: fetch });
      const cfg = readEndpointConfig(db);
      expect(cfg.url).toBe("https://new.example.com");
      expect(cfg.token).toBe("new-token");
    });
  });

  describe("disconnectEndpoint", () => {
    it("deletes both credentials and leaves the poll cadences intact", async () => {
      setEndpoint(db, "https://store.example.com", "tok");
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('poll_active_interval_ms', '7000', datetime('now'))").run();
      disconnectEndpoint(db);
      const cfg = readEndpointConfig(db);
      expect(cfg.connected).toBe(false);
      expect(cfg.url).toBe("");
      expect(cfg.token).toBe("");
      expect(cfg.activePollIntervalMs).toBe(7_000); // cadence survives
    });
  });

  describe("pushOutbox", () => {
    it("returns 'not connected' and sends nothing when no endpoint is configured", async () => {
      const { fetch, calls } = fakeFetch(() => ({ status: 200, body: {} }));
      enqueueOp(db, validOp(1));
      const res = await pushOutbox(db, { fetchImpl: fetch });
      expect(res).toEqual({ attempted: 0, delivered: 0, conflicts: [], error: "not connected" });
      expect(calls.length).toBe(0);
      expect(outboxRow(db, 1).status).toBe("pending");
    });

    it("ships due ops in local-seq order with client_seq = outbox id and Bearer auth", async () => {
      setEndpoint(db, "https://store.test", "tok-1");
      const id1 = enqueueOp(db, validOp(1));
      const id2 = enqueueOp(db, validOp(2));
      const id3 = enqueueOp(db, validOp(3));

      let received: Array<Record<string, unknown>> = [];
      const { fetch, calls } = fakeFetch(() => {
        const body = JSON.parse((calls[0].init?.body as string) ?? "[]");
        received = body;
        return {
          status: 200,
          body: {
            machine_id: MID,
            results: body.map((op: Record<string, unknown>, i: number) => ({
              client_seq: op.client_seq,
              seq: i + 1,
              status: "accepted",
              duplicate: false,
            })),
          },
        };
      });

      const res = await pushOutbox(db, { fetchImpl: fetch });
      expect(res.error).toBeNull();
      expect(res.attempted).toBe(3);
      expect(res.delivered).toBe(3);
      expect(res.conflicts).toEqual([]);

      // Wire order = local-seq order, client_seq = outbox id.
      expect(received.map((r) => r.client_seq)).toEqual([id1, id2, id3]);
      // The single request carried all three in one batch.
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://store.test/ops");
      expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
      expect((calls[0].init?.headers as Record<string, string>)["content-type"]).toBe("application/json");

      // All acked with the server-assigned seqs.
      for (let i = 0; i < 3; i++) {
        const row = outboxRow(db, [id1, id2, id3][i]);
        expect(row.status).toBe("acked");
        expect(row.server_seq).toBe(i + 1);
        expect(row.attempts).toBe(0);
      }
    });

    it("rewrites base_version at send time from the local per-gid high-water mark (spec 1.7 client protocol)", async () => {
      setEndpoint(db);
      // Two ops for the SAME gid: first is a stored-null create at version 0
      // (stays null), the second must go out with base_version 1 — NOT the
      // hardcoded 0 the Phase 3 write sites stored.
      const idA = enqueueOp(db, validOp(10, { kind: "file.create", base_version: null }));
      const idB = enqueueOp(db, validOp(10, { kind: "file.update", base_version: 0 }));
      // And a second gid with one op stored-null at version 0: stays null.
      enqueueOp(db, validOp(11, { kind: "file.create", base_version: null }));

      let received: Array<Record<string, unknown>> = [];
      const { fetch, calls } = fakeFetch(() => {
        const body = JSON.parse((calls[0].init?.body as string) ?? "[]");
        received = body;
        return {
          status: 200,
          body: {
            results: body.map((op: Record<string, unknown>, i: number) => ({
              client_seq: op.client_seq, seq: i + 1, status: "accepted", duplicate: false,
            })),
          },
        };
      });
      await pushOutbox(db, { fetchImpl: fetch });

      const bySeq = new Map(received.map((r) => [r.client_seq, r]));
      expect(bySeq.get(idA)?.base_version).toBeNull(); // first create at version 0
      expect(bySeq.get(idB)?.base_version).toBe(1); // predecessor counted in-batch
      // The second gid's create (fresh gid) stays null.
      const create11 = received.find((r) => String(r.gid).startsWith("11@"))!;
      expect(create11.base_version).toBeNull();
      // The stored value is never mutated — the outbox row still holds 0.
      expect((db.prepare("SELECT base_version FROM outbox WHERE id = ?").get(idB) as { base_version: number | null }).base_version).toBe(0);
    });

    it("continues the base_version chain across pushes (acked count + in-batch predecessors)", async () => {
      setEndpoint(db);
      const mk = (i: number) => () => ({
        status: 200,
        body: {
          results: JSON.parse((calls[i].init?.body as string) ?? "[]").map(
            (op: Record<string, unknown>, j: number) => ({
              client_seq: op.client_seq,
              seq: j + 1 + i,
              status: "accepted",
              duplicate: false,
            }),
          ),
        },
      });
      const calls: RecordedRequest[] = [];
      const { fetch } = fakeFetch((url, init) => {
        calls.push({ url, init });
        return mk(calls.length - 1)();
      });

      const idA = enqueueOp(db, validOp(20, { kind: "file.create", base_version: null }));
      await pushOutbox(db, { fetchImpl: fetch }); // v0 -> acked
      const idB = enqueueOp(db, validOp(20)); // stored base_version 0, must wire as 1
      const idC = enqueueOp(db, validOp(20)); // must wire as 2 (predecessor in batch)
      await pushOutbox(db, { fetchImpl: fetch });

      const bySeq = new Map(calls[1].init?.body === undefined ? [] : (JSON.parse(calls[1].init!.body as string).map((r: Record<string, unknown>) => [r.client_seq, r.base_version])));
      expect(bySeq.get(idB)).toBe(1);
      expect(bySeq.get(idC)).toBe(2);
      expect(idA).toBeTypeOf("number");
    });

    it("acknowledges idempotent duplicates: a retried batch re-delivers but acks the ORIGINAL seq", async () => {
      setEndpoint(db);
      const id = enqueueOp(db, validOp(1));
      let first = true;
      const { fetch } = fakeFetch((url, init) => {
        if (url.endsWith("/ops") && init?.body) {
          const body = JSON.parse(init.body as string);
          if (first) {
            first = false;
            // Simulate a lost ACK: the server stored the op (seq 1) but the
            // response never arrived — the client marked the row sent, then
            // "crashed". Re-queue happens on the next push.
            db.prepare("UPDATE outbox SET status = 'sent' WHERE id = ?").run(id);
            throw new TypeError("socket closed before response");
          }
          // The retry: the server dedups on (origin, client_seq) and returns
          // the ORIGINAL seq with duplicate: true.
          expect(body[0].client_seq).toBe(id);
          return {
            status: 200,
            body: { results: [{ client_seq: id, seq: 1, status: "accepted", duplicate: true }] },
          };
        }
        return { status: 200, body: { ops: [], next: 0 } };
      });

      const r1 = await pushOutbox(db, { fetchImpl: fetch });
      expect(r1.error).toMatch(/socket closed/);
      expect(r1.delivered).toBe(0);
      expect(outboxRow(db, id).status).toBe("failed");
      expect(outboxRow(db, id).attempts).toBe(1);

      // The backoff window is 1 s; simulate it elapsing.
      db.prepare("UPDATE outbox SET next_attempt_at = ? WHERE id = ?").run(Date.now() - 1, id);
      const r2 = await pushOutbox(db, { fetchImpl: fetch });
      expect(r2.error).toBeNull();
      expect(r2.delivered).toBe(1);
      const row = outboxRow(db, id);
      expect(row.status).toBe("acked");
      expect(row.server_seq).toBe(1); // the ORIGINAL seq, not a second one
    });

    it("marks the whole batch failed with per-op backoff on a non-200 response", async () => {
      setEndpoint(db);
      const id1 = enqueueOp(db, validOp(1));
      const id2 = enqueueOp(db, validOp(2));
      const { fetch } = fakeFetch(() => ({ status: 500, raw: "boom" }));

      const res = await pushOutbox(db, { fetchImpl: fetch });
      expect(res.attempted).toBe(2);
      expect(res.delivered).toBe(0);
      expect(res.error).toMatch(/HTTP 500/);
      for (const id of [id1, id2]) {
        const row = outboxRow(db, id);
        expect(row.status).toBe("failed");
        expect(row.attempts).toBe(1);
        expect(row.last_error).toMatch(/HTTP 500/);
        // The backoff deadline is ~1 s out (first failure) and in the future.
        expect(row.next_attempt_at!).toBeGreaterThan(Date.now() + 900);
        expect(row.next_attempt_at!).toBeLessThanOrEqual(Date.now() + 2_000);
      }
    });

    it("does not re-attempt a failed op before its backoff window elapses", async () => {
      setEndpoint(db);
      const id = enqueueOp(db, validOp(1));
      const { fetch } = fakeFetch((url) => {
        if (url.endsWith("/ops") && (fetch as unknown as { count?: number }).count === undefined) {
          (fetch as unknown as { count?: number }).count = 1;
          return { status: 500, raw: "x" };
        }
        return { status: 200, body: { results: [] } };
      });
      await pushOutbox(db, { fetchImpl: fetch }); // fails, backoff 1 s
      const again = await pushOutbox(db, { fetchImpl: fetch });
      // The op is still in backoff — nothing was selected.
      expect(again.attempted).toBe(0);
      expect(outboxRow(db, id).status).toBe("failed");
      expect(outboxRow(db, id).attempts).toBe(1);
    });

    it("escalates the backoff per attempt (attempt 2 waits 2 s)", async () => {
      setEndpoint(db);
      const id = enqueueOp(db, validOp(1));
      let n = 0;
      const { fetch } = fakeFetch(() => {
        n++;
        if (n <= 2) return { status: 503, raw: "down" };
        return { status: 200, body: { results: [] } };
      });
      await pushOutbox(db, { fetchImpl: fetch });
      expect(outboxRow(db, id).attempts).toBe(1);
      const firstDeadline = outboxRow(db, id).next_attempt_at!;
      expect(firstDeadline).toBeLessThanOrEqual(Date.now() + BACKOFF_INITIAL_MS + 1);

      db.prepare("UPDATE outbox SET next_attempt_at = ? WHERE id = ?").run(Date.now() - 1, id);
      await pushOutbox(db, { fetchImpl: fetch });
      expect(outboxRow(db, id).attempts).toBe(2);
      const secondDeadline = outboxRow(db, id).next_attempt_at!;
      // Second failure: ~2 s from now — clearly longer than the first window.
      expect(secondDeadline).toBeGreaterThan(firstDeadline + 900);

      // And the third attempt (after the window) succeeds and acks.
      db.prepare("UPDATE outbox SET next_attempt_at = ? WHERE id = ?").run(Date.now() - 1, id);
      const { fetch: okFetch } = fakeFetch(() => ({
        status: 200,
        body: { results: [{ client_seq: id, seq: 7, status: "accepted", duplicate: false }] },
      }));
      const ok = await pushOutbox(db, { fetchImpl: okFetch });
      expect(ok.delivered).toBe(1);
      expect(outboxRow(db, id).status).toBe("acked");
      expect(outboxRow(db, id).server_seq).toBe(7);
    });

    it("re-queues orphaned 'sent' rows (crash recovery) without losing or double-acking them", async () => {
      setEndpoint(db);
      const id = enqueueOp(db, validOp(1));
      // The process died after markSent but before the ack landed.
      markSent(db, [id]);
      expect(outboxRow(db, id).status).toBe("sent");

      const { fetch } = fakeFetch(() => ({
        status: 200,
        body: { results: [{ client_seq: id, seq: 42, status: "accepted", duplicate: false }] },
      }));
      const res = await pushOutbox(db, { fetchImpl: fetch });
      expect(res.attempted).toBe(1);
      expect(res.delivered).toBe(1);
      const row = outboxRow(db, id);
      expect(row.status).toBe("acked");
      expect(row.server_seq).toBe(42);
    });

    it("reports server-flagged conflicts as delivered AND surfaced (not retried)", async () => {
      setEndpoint(db);
      const id = enqueueOp(db, validOp(1));
      const { fetch } = fakeFetch(() => ({
        status: 200,
        body: { results: [{ client_seq: id, seq: 3, status: "conflict", duplicate: false }] },
      }));
      const res = await pushOutbox(db, { fetchImpl: fetch });
      expect(res.delivered).toBe(1);
      expect(res.conflicts.length).toBe(1);
      expect(res.conflicts[0].gid).toBe(`${1}@${MID}`);
      // Delivered is terminal: the op is acked (the server log is authoritative).
      expect(outboxRow(db, id).status).toBe("acked");
      expect(outboxRow(db, id).server_seq).toBe(3);
    });

    it("caps a single batch at MAX_BATCH_SIZE and drains the rest on the next tick", async () => {
      setEndpoint(db);
      // 1001 ops — one over the cap.
      for (let i = 0; i < MAX_BATCH_SIZE + 1; i++) {
        enqueueOp(db, validOp(i + 1, { gid: `${i + 1}@${MID}` }));
      }
      const { fetch } = fakeFetch((url, init) => ({
        status: 200,
        body: {
          results: (JSON.parse((init?.body as string) ?? "[]")).map((op: Record<string, unknown>, i: number) => ({
            client_seq: op.client_seq, seq: i + 1, status: "accepted", duplicate: false,
          })),
        },
      }));
      const r1 = await pushOutbox(db, { fetchImpl: fetch });
      expect(r1.attempted).toBe(MAX_BATCH_SIZE);
      const r2 = await pushOutbox(db, { fetchImpl: fetch });
      expect(r2.attempted).toBe(1);
      expect(r2.delivered).toBe(1);
    });
  });

  describe("sync cursor (sync_cursor)", () => {
    it("starts at 0 (fetch full history on first poll)", () => {
      expect(getSyncCursor(db)).toBe(0);
    });

    it("is monotonic: a lower seq can never regress it", () => {
      advanceSyncCursor(db, 50);
      expect(getSyncCursor(db)).toBe(50);
      advanceSyncCursor(db, 40); // regression attempt
      expect(getSyncCursor(db)).toBe(50);
      advanceSyncCursor(db, 51);
      expect(getSyncCursor(db)).toBe(51);
    });
  });

  describe("pullRemoteOps", () => {
    /** A remote file.update op row for GET /ops responses. */
    const remoteRow = (seq: number, n: number, over: Record<string, unknown> = {}) => ({
      seq,
      gid: REMOTE_GID(n),
      kind: "file.update",
      origin: REMOTE_MID,
      base_version: 0,
      payload: { path: join(testDir, "knowledge", `r${n}.md`), content: `remote-${n}` },
      created_at: 1_700_000_000_500 + n,
      status: "accepted",
      ...over,
    });

    /** Serve GET /ops from an in-memory log, honoring since + limit like the real server. */
    const serveGet = (rows: Array<Record<string, unknown>>) => (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const since = Number(u.searchParams.get("since") ?? "0");
      const limit = Number(u.searchParams.get("limit") ?? "1000");
      const page = rows.filter((r) => (r.seq as number) > since).slice(0, limit);
      return {
        status: 200,
        body: { ops: page, next: page.length > 0 ? page[page.length - 1].seq : since },
      };
    };

    it("applies remote ops and advances the cursor past a clean page", async () => {
      setEndpoint(db, "https://store.test", "tok-1");
      const { fetch, calls } = fakeFetch(serveGet([remoteRow(1, 1), remoteRow(2, 2)]));

      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toBeNull();
      expect(res.polled).toBe(2);
      expect(res.applied).toBe(2);
      expect(res.conflicts).toEqual([]);
      expect(res.cursor).toBe(2);
      expect(getSyncCursor(db)).toBe(2);

      // Both remote files landed on disk + in the files table with their gids.
      for (const n of [1, 2]) {
        const p = join(testDir, "knowledge", `r${n}.md`);
        expect(existsSync(p)).toBe(true);
        const row = db.prepare("SELECT gid FROM files WHERE path = ?").get(p) as
          | { gid: string }
          | undefined;
        expect(row?.gid).toBe(REMOTE_GID(n));
      }
      // Authenticated with the machine token, polling from the cursor.
      expect(calls[0].url).toContain("/ops?since=0");
      expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    });

    it("skips own-origin ops (the server echoes our own log back)", async () => {
      setEndpoint(db);
      enqueueOp(db, validOp(5)); // outbox id 1
      const rows = [remoteRow(1, 1, { gid: `${5}@${MID}`, origin: MID })]; // OUR op, seq 1
      const { fetch } = fakeFetch(serveGet(rows));

      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toBeNull();
      expect(res.polled).toBe(1);
      expect(res.applied).toBe(0); // skipped, not re-applied
      expect(res.cursor).toBe(1); // still advanced past it
      expect(getSyncCursor(db)).toBe(1);
    });

    it("pages until caught up (a full page triggers the next request)", async () => {
      setEndpoint(db);
      const { fetch, calls } = fakeFetch(serveGet([remoteRow(1, 1), remoteRow(2, 2), remoteRow(3, 3)]));
      const res = await pullRemoteOps(db, { fetchImpl: fetch, pageLimit: 2 });
      expect(res.error).toBeNull();
      expect(res.applied).toBe(3);
      expect(res.cursor).toBe(3);
      expect(calls.length).toBe(2);
      expect(calls[1].url).toContain("since=2");
    });

    it("reports an empty poll as caught up without advancing the cursor", async () => {
      setEndpoint(db);
      advanceSyncCursor(db, 9);
      const { fetch, calls } = fakeFetch(serveGet([remoteRow(1, 1)])); // all <= cursor
      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toBeNull();
      expect(res.polled).toBe(0);
      expect(res.cursor).toBe(9);
      expect(getSyncCursor(db)).toBe(9);
      expect(calls[0].url).toContain("since=9");
    });

    it("fails closed on a malformed op without advancing cursor past it", async () => {
      setEndpoint(db);
      const { fetch } = fakeFetch(serveGet([
        remoteRow(1, 1),
        { seq: 2, gid: "invalid-gid-format", kind: "file.update", origin: REMOTE_MID, payload: {} },
      ]));
      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toMatch(/refusing to advance past malformed op \(seq 2\)/);
      // It applied seq 1, keeps that progress, and stops before the malformed seq 2
      expect(res.applied).toBe(1);
      expect(res.cursor).toBe(1);
      expect(getSyncCursor(db)).toBe(1);
    });

    it("surfaces server-flagged conflicts in res.conflicts and applies the op when no local file exists", async () => {
      setEndpoint(db);
      const conflictRow = remoteRow(1, 1, { status: "conflict" });
      const { fetch } = fakeFetch(serveGet([conflictRow]));
      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toBeNull();
      expect(res.applied).toBe(1);
      expect(res.cursor).toBe(1);
      expect(res.conflicts.length).toBe(1);
      expect(res.conflicts[0].gid).toBe(REMOTE_GID(1));
    });

    it("records gid_version from pulled rows and bases the next push on it", async () => {
      setEndpoint(db);
      const { fetch } = fakeFetch(serveGet([remoteRow(1, 7, { gid_version: 3 })]));
      expect((await pullRemoteOps(db, { fetchImpl: fetch })).error).toBeNull();
      expect(db.prepare("SELECT version FROM gid_versions WHERE gid = ?").get(REMOTE_GID(7))).toEqual({ version: 3 });

      const id = enqueueOp(db, validOp(7, { gid: REMOTE_GID(7), kind: "file.update", base_version: 0 }));
      const sent = fakeFetch((url, init) => {
        const body = JSON.parse(init!.body as string) as Array<Record<string, unknown>>;
        return { status: 200, body: { results: body.map((o) => ({ client_seq: o.client_seq, seq: 9, status: "accepted", duplicate: false, version: 4 })) } };
      });
      await pushOutbox(db, { fetchImpl: sent.fetch });
      expect(JSON.parse(sent.calls[0].init!.body as string)[0].base_version).toBe(3);
      expect(outboxRow(db, id).status).toBe("acked");
      expect(db.prepare("SELECT version FROM gid_versions WHERE gid = ?").get(REMOTE_GID(7))).toEqual({ version: 4 });
    });

    it("skips an unappliable op (path outside the data dir), records it, and keeps applying later ops", async () => {
      setEndpoint(db);
      const evil = remoteRow(1, 1, { payload: { path: "/etc/kontexta-evil.md", content: "x" } });
      const { fetch } = fakeFetch(serveGet([evil, remoteRow(2, 2)]));
      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toBeNull();
      expect(res.skipped).toBe(1);
      expect(res.applied).toBe(1);
      expect(res.cursor).toBe(2);
      expect(getSyncCursor(db)).toBe(2);
      expect(existsSync("/etc/kontexta-evil.md")).toBe(false);
      const skipped = db.prepare("SELECT seq, skipped FROM sync_skipped_ops").all();
      expect(skipped).toEqual([{ seq: 1, skipped: 1 }]);
      expect(existsSync(join(testDir, "knowledge", "r2.md"))).toBe(true);
    });

    it("retries a transient apply failure, then skips it after MAX_APPLY_ATTEMPTS", async () => {
      setEndpoint(db);
      // A regular file where the knowledge dir should be makes the disk write throw a non-Unappliable error.
      writeFileSync(join(testDir, "knowledge"), "not a dir");
      const { fetch } = fakeFetch(serveGet([remoteRow(1, 1), remoteRow(2, 2)]));
      for (let i = 1; i < MAX_APPLY_ATTEMPTS; i++) {
        const res = await pullRemoteOps(db, { fetchImpl: fetch });
        expect(res.error, `attempt ${i}`).toMatch(/failed to apply seq 1/);
        expect(res.cursor).toBe(0);
        expect(db.prepare("SELECT attempts, skipped FROM sync_skipped_ops WHERE seq = 1").get()).toEqual({ attempts: i, skipped: 0 });
      }
      const last = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(last.skipped).toBe(1); // seq 1 is given up on; seq 2 is now the one being retried
      expect(last.error).toMatch(/failed to apply seq 2/);
      expect(db.prepare("SELECT skipped FROM sync_skipped_ops WHERE seq = 1").get()).toEqual({ skipped: 1 });
    });

    it("forks a conflict copy for a conflict-flagged file.update and leaves the canonical file intact", async () => {
      setEndpoint(db);
      const canonical = join(testDir, "knowledge", "r1.md");
      const first = fakeFetch(serveGet([remoteRow(1, 1)]));
      await pullRemoteOps(db, { fetchImpl: first.fetch });
      expect(readFileSync(canonical, "utf8")).toBe("remote-1");

      const conflictOp = remoteRow(2, 1, {
        origin: "bbbbbbbbbbbbbbbb",
        status: "conflict",
        payload: { path: canonical, content: "loser-content" },
      });
      const second = fakeFetch(serveGet([remoteRow(1, 1), conflictOp]));
      const res = await pullRemoteOps(db, { fetchImpl: second.fetch });
      expect(res.error).toBeNull();
      expect(res.conflicts.length).toBe(1);
      expect(readFileSync(canonical, "utf8")).toBe("remote-1");
      const rows = db.prepare("SELECT gid, status, remote_content FROM conflicts").all() as Array<Record<string, unknown>>;
      expect(rows).toEqual([{ gid: REMOTE_GID(1), status: "unresolved", remote_content: "loser-content" }]);
      expect(res.cursor).toBe(2);
    });

    it("returns 'not connected' when endpoint credentials are not set", async () => {
      const { fetch, calls } = fakeFetch(serveGet([]));
      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toBe("not connected");
      expect(calls.length).toBe(0);
    });

    it("handles HTTP errors cleanly without advancing cursor", async () => {
      setEndpoint(db);
      const { fetch } = fakeFetch(() => ({ status: 500, raw: "server error" }));
      const res = await pullRemoteOps(db, { fetchImpl: fetch });
      expect(res.error).toMatch(/HTTP 500/);
      expect(res.cursor).toBe(0);
    });
  });

  describe("syncLoop / startSyncLoop (adaptive short-polling)", () => {
    it("is a process singleton: startSyncLoop returns existing handle, syncLoop is alias, stopSyncLoop resets", () => {
      const h1 = startSyncLoop(db, { autoStart: false });
      expect(getSyncLoop()).toBe(h1);
      const h2 = syncLoop(db, { autoStart: false });
      expect(h2).toBe(h1);
      stopSyncLoop();
      expect(getSyncLoop()).toBeNull();
    });

    it("ticks push then pull in a single round-trip", async () => {
      setEndpoint(db, "https://store.test", "tok-1");
      const id = enqueueOp(db, validOp(1));
      const remote = {
        seq: 1,
        gid: REMOTE_GID(10),
        kind: "file.update",
        origin: REMOTE_MID,
        base_version: 0,
        payload: { path: join(testDir, "knowledge", "r10.md"), content: "remote-10" },
        created_at: 1_700_000_000_100,
        status: "accepted",
      };

      const { fetch } = fakeFetch((url, init) => {
        if (url.endsWith("/ops") && init?.method === "POST") {
          return {
            status: 200,
            body: { results: [{ client_seq: id, seq: 100, status: "accepted", duplicate: false }] },
          };
        }
        if (url.includes("/ops?since=")) {
          return {
            status: 200,
            body: { ops: [remote], next: 1 },
          };
        }
        return { status: 404 };
      });

      const handle = startSyncLoop(db, { autoStart: false, fetchImpl: fetch });
      const res = await handle.tick();
      expect(res.phase).toBe("ok");
      expect(res.push?.delivered).toBe(1);
      expect(res.pull?.applied).toBe(1);
      expect(handle.state().lastSyncAt).not.toBeNull();
      expect(handle.state().cursor).toBe(1);
      expect(handle.state().pending).toBe(0);
    });

    it("returns phase 'disconnected' and sleeps idle interval when endpoint not configured", async () => {
      const handle = startSyncLoop(db, { autoStart: false });
      const res = await handle.tick();
      expect(res.phase).toBe("disconnected");
      expect(res.push).toBeNull();
      expect(res.pull).toBeNull();
      expect(res.nextDelayMs).toBe(IDLE_POLL_INTERVAL_DEFAULT_MS);
      expect(handle.state().connected).toBe(false);
    });

    it("adapts cadence between active and idle intervals based on activity and pending outbox", async () => {
      setEndpoint(db);
      const { fetch } = fakeFetch((url) => {
        if (url.includes("/ops?since=")) {
          return { status: 200, body: { ops: [], next: 0 } };
        }
        return { status: 200, body: { results: [] } };
      });

      let activity = false;
      const handle = startSyncLoop(db, {
        autoStart: false,
        fetchImpl: fetch,
        isActivity: () => activity,
        activePollIntervalMs: 5_000,
        idlePollIntervalMs: 20_000,
      });

      // Quiet (no activity, no pending outbox) -> idle delay
      const r1 = await handle.tick();
      expect(r1.nextDelayMs).toBe(20_000);

      // Active probe returns true -> active delay
      activity = true;
      const r2 = await handle.tick();
      expect(r2.nextDelayMs).toBe(5_000);
    });

    it("executes exponential backoff on tick failure, resetting on recovery", async () => {
      setEndpoint(db);
      let fail = true;
      const { fetch } = fakeFetch(() => {
        if (fail) return { status: 503, raw: "server unavailable" };
        return { status: 200, body: { results: [], ops: [], next: 0 } };
      });

      enqueueOp(db, validOp(1));
      const handle = startSyncLoop(db, {
        autoStart: false,
        fetchImpl: fetch,
        backoffInitialMs: 100,
        backoffMaxMs: 1000,
      });

      // Failure 1: delay = 100ms
      const r1 = await handle.tick();
      expect(r1.phase).toBe("backoff");
      expect(r1.nextDelayMs).toBe(100);
      expect(handle.state().consecutiveFailures).toBe(1);
      expect(handle.state().backoffMs).toBe(100);
      expect(handle.state().lastError).toMatch(/503/);

      // Failure 2: delay doubles to 200ms
      const r2 = await handle.tick();
      expect(r2.phase).toBe("backoff");
      expect(r2.nextDelayMs).toBe(200);
      expect(handle.state().consecutiveFailures).toBe(2);
      expect(handle.state().backoffMs).toBe(200);

      // Recovery: resets consecutiveFailures and backoffMs
      fail = false;
      const r3 = await handle.tick();
      expect(r3.phase).toBe("ok");
      expect(handle.state().consecutiveFailures).toBe(0);
      expect(handle.state().backoffMs).toBe(0);
      expect(handle.state().lastError).toBeNull();
    });

    it("stops the loop and clears state when abort signal fires", () => {
      const ctrl = new AbortController();
      const handle = startSyncLoop(db, { autoStart: false, signal: ctrl.signal });
      expect(handle.state().running).toBe(true);
      ctrl.abort();
      expect(handle.state().running).toBe(false);
      expect(getSyncLoop()).toBeNull();
    });

    it("returns accurate runtime state snapshot via handle.state()", () => {
      setEndpoint(db);
      const handle = startSyncLoop(db, { autoStart: false });
      const st = handle.state();
      expect(st).toEqual({
        running: true,
        connected: true,
        lastSyncAt: null,
        lastError: null,
        backoffMs: 0,
        consecutiveFailures: 0,
        cursor: 0,
        pending: 0,
      });
    });
  });
});
