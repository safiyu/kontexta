import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Hono } from "hono";
import { createApp } from "../../../../storage-server/src/server.js";
import { resetDataDirCache } from "../../../src/util/paths.js";
import { joinBrain } from "../../../src/storage/brain.js";
import { bootstrapIfNeeded } from "../../../src/storage/bootstrap.js";
import { pullRemoteOps, pushOutbox } from "../../../src/storage/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, "..", "..", "..", "src", "db", "migrations");
const SERVER_SCHEMA = readFileSync(join(here, "..", "..", "..", "..", "storage-server", "src", "db", "schema.sql"), "utf-8");

export const HOST_URL = "http://brain.test";

export interface Host {
  app: Hono;
  db: Database.Database;
  fetch: typeof fetch;
  close(): void;
}

/** An in-process brain host that lets anyone create brains (tests only). */
export function createHost(): Host {
  const db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  process.env.KXTA_BRAIN_ALLOW_OPEN_CREATE = "1";
  const app = createApp(db);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return app.request(u.pathname + u.search, init);
  }) as typeof fetch;
  return { app, db, fetch: f, close: () => db.close() };
}

export interface Machine {
  id: string;
  label: string;
  db: Database.Database;
  dir: string;
}

/** A machine: its own in-memory vault database and its own data directory. */
export function createMachine(id: string, label: string): Machine {
  const dir = mkdtempSync(join(tmpdir(), `kxta-m-${label}-`));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), "utf-8"));
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('machine_id', ?, datetime('now'))").run(id);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('machine_label', ?, datetime('now'))").run(label);
  return { id, label, db, dir };
}

/** Make `m` the active machine: file ops resolve against its data directory. */
export function use(m: Machine): Machine {
  process.env.KONTEXTA_DATA_DIR = m.dir;
  resetDataDirCache();
  return m;
}

export function disposeMachine(m: Machine): void {
  try {
    m.db.close();
  } catch {}
  if (existsSync(m.dir)) rmSync(m.dir, { recursive: true, force: true });
}

export function writeKb(m: Machine, rel: string, content: string): string {
  const p = join(m.dir, "knowledge", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

/** Join (or create) a brain, bootstrap, then push and pull until quiet. */
export async function connect(m: Machine, host: Host, opts: { shareId?: string; create?: boolean }): Promise<string> {
  use(m);
  const r = await joinBrain(m.db, HOST_URL, { ...opts, hostname: m.label, fetchImpl: host.fetch });
  await bootstrapIfNeeded(m.db, { fetchImpl: host.fetch });
  await sync(m, host);
  return r.shareId;
}

/** One full push-then-pull round on `m`. */
export async function sync(m: Machine, host: Host): Promise<void> {
  use(m);
  const push = await pushOutbox(m.db, { fetchImpl: host.fetch });
  if (push.error) throw new Error(`push failed on ${m.label}: ${push.error}`);
  const pull = await pullRemoteOps(m.db, { fetchImpl: host.fetch });
  if (pull.error) throw new Error(`pull failed on ${m.label}: ${pull.error}`);
}
