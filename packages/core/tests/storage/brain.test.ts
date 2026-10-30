import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { resetDataDirCache } from "../../src/util/paths.js";
import {
  readBrainConfig,
  storeShareId,
  revealShareId,
  disconnectBrain,
  joinBrain,
  settingUpsert,
  normalizeBaseUrl,
} from "../../src/storage/brain.js";
import { generateShareId, formatShareId, parseShareId } from "../../src/storage/shareid.js";
import { recordGidVersion } from "../../src/storage/versions.js";
import { enqueueOp, markAcked } from "../../src/storage/outbox.js";
import type { Database } from "better-sqlite3";

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kxta-brain-"));
  process.env.KONTEXTA_DATA_DIR = dir;
  resetDataDirCache();
  db = createDatabase(join(dir, "t.db"));
});
afterEach(() => {
  delete process.env.KONTEXTA_DATA_DIR;
  resetDataDirCache();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown };
function fakeFetch(h: Handler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const out = h(url, init);
    return new Response(out.body === undefined ? "" : JSON.stringify(out.body), { status: out.status ?? 200 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
const okHost = (join: { created?: boolean; name?: string; token?: string } = {}): Handler => (url) =>
  url.endsWith("/health")
    ? { body: { status: "ok", service: "kontexta-brain-host" } }
    : { status: join.created === false ? 200 : 201, body: { brain_id: 1, name: join.name ?? "Mine", created: join.created ?? true, token: join.token ?? "t".repeat(64), latest_seq: 5 } };

describe("readBrainConfig", () => {
  it("is disconnected until url, token and share hash are all set", () => {
    expect(readBrainConfig(db).connected).toBe(false);
    settingUpsert(db, "remote_url", "https://x.test");
    settingUpsert(db, "remote_token", "tok");
    expect(readBrainConfig(db).connected).toBe(false);
    settingUpsert(db, "brain_share_hash", "h");
    expect(readBrainConfig(db)).toMatchObject({ connected: true, remoteUrl: "https://x.test", token: "tok", shareHash: "h" });
  });

  it("falls back to the default cadences for malformed intervals", () => {
    settingUpsert(db, "poll_active_interval_ms", "5");
    settingUpsert(db, "poll_idle_interval_ms", "120000");
    const c = readBrainConfig(db);
    expect(c.activePollIntervalMs).toBe(15_000);
    expect(c.idlePollIntervalMs).toBe(120_000);
  });

  it("normalizeBaseUrl trims, strips slashes and rejects non-http", () => {
    expect(normalizeBaseUrl("  https://a.test/// ")).toBe("https://a.test");
    expect(() => normalizeBaseUrl("ftp://a.test")).toThrow();
  });
});

describe("share id storage", () => {
  it("round-trips through the machine secret and is not stored in clear", () => {
    const bytes = generateShareId();
    storeShareId(db, bytes);
    expect(revealShareId(db)).toBe(formatShareId(bytes));
    const stored = (db.prepare("SELECT value FROM settings WHERE key = 'brain_share_id_enc'").get() as { value: string }).value;
    expect(stored).not.toContain(Buffer.from(bytes).toString("hex"));
  });

  it("revealShareId is null when none was kept", () => {
    expect(revealShareId(db)).toBeNull();
  });
});

describe("joinBrain", () => {
  it("create generates a share id, persists the config, and returns it formatted", async () => {
    const { fetch, calls } = fakeFetch(okHost());
    const r = await joinBrain(db, "https://host.test/", { create: true, name: "Mine", hostname: "laptop", enrollSecret: "s3cret", fetchImpl: fetch });
    expect(r).toMatchObject({ created: true, name: "Mine", latestSeq: 5, sameBrainAsBefore: false });
    expect(r.shareId).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    const cfg = readBrainConfig(db);
    expect(cfg).toMatchObject({ connected: true, remoteUrl: "https://host.test", name: "Mine" });
    expect(cfg.shareHash).toBe(createHash("sha256").update(parseShareId(r.shareId)!).digest("hex"));
    const joinCall = calls.find((c) => c.url.endsWith("/brains/join"))!;
    expect((joinCall.init!.headers as Record<string, string>)["x-enroll-secret"]).toBe("s3cret");
    expect(revealShareId(db)).toBe(r.shareId);
  });

  it("joining the same brain again keeps the cursor and does not re-pend history", async () => {
    const s = formatShareId(generateShareId());
    const { fetch } = fakeFetch(okHost({ created: false }));
    await joinBrain(db, "https://host.test", { shareId: s, hostname: "h", fetchImpl: fetch });
    db.prepare("UPDATE sync_cursor SET last_seq = 42 WHERE id = 1").run();
    const second = await joinBrain(db, "https://host.test", { shareId: s, hostname: "h", fetchImpl: fetch });
    expect(second.sameBrainAsBefore).toBe(true);
    expect((db.prepare("SELECT last_seq FROM sync_cursor WHERE id = 1").get() as { last_seq: number }).last_seq).toBe(42);
  });

  it("joining a different brain resets cursor and versions and re-pends acked history", async () => {
    const { fetch } = fakeFetch(okHost({ created: false }));
    await joinBrain(db, "https://host.test", { shareId: formatShareId(generateShareId()), hostname: "h", fetchImpl: fetch });
    db.prepare("UPDATE sync_cursor SET last_seq = 42 WHERE id = 1").run();
    recordGidVersion(db, "1@aaaaaaaaaaaaaaaa", 4);
    const id = enqueueOp(db, { gid: "1@aaaaaaaaaaaaaaaa", kind: "file.update", origin: "aaaaaaaaaaaaaaaa", base_version: 0, payload: {}, created_at: 1 });
    markAcked(db, id, 9);
    const other = await joinBrain(db, "https://host.test", { shareId: formatShareId(generateShareId()), hostname: "h", fetchImpl: fetch });
    expect(other.sameBrainAsBefore).toBe(false);
    expect((db.prepare("SELECT last_seq FROM sync_cursor WHERE id = 1").get() as { last_seq: number }).last_seq).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM gid_versions").get()).toEqual({ n: 0 });
    expect((db.prepare("SELECT status FROM outbox WHERE id = ?").get(id) as { status: string }).status).toBe("pending");
    expect((db.prepare("SELECT value FROM settings WHERE key = 'brain_bootstrap_pending'").get() as { value: string }).value).toBe("1");
  });

  it("persists nothing when the server rejects the join, or is not a brain host", async () => {
    const reject = fakeFetch((url) => (url.endsWith("/health") ? { body: { service: "kontexta-brain-host" } } : { status: 403, body: { error: "invalid enrollment secret" } }));
    await expect(joinBrain(db, "https://host.test", { create: true, hostname: "h", fetchImpl: reject.fetch })).rejects.toThrow(/invalid enrollment secret/);
    const wrong = fakeFetch(() => ({ body: { service: "something-else" } }));
    await expect(joinBrain(db, "https://host.test", { create: true, hostname: "h", fetchImpl: wrong.fetch })).rejects.toThrow(/not a kontexta brain host/);
    expect(readBrainConfig(db).connected).toBe(false);
  });

  it("disconnectBrain keeps the share hash and the cursor", async () => {
    const { fetch } = fakeFetch(okHost());
    await joinBrain(db, "https://host.test", { create: true, hostname: "h", fetchImpl: fetch });
    db.prepare("UPDATE sync_cursor SET last_seq = 7 WHERE id = 1").run();
    disconnectBrain(db);
    const cfg = readBrainConfig(db);
    expect(cfg.connected).toBe(false);
    expect(cfg.shareHash).not.toBe("");
    expect((db.prepare("SELECT last_seq FROM sync_cursor WHERE id = 1").get() as { last_seq: number }).last_seq).toBe(7);
  });
});
