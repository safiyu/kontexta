/**
 * Storage-server database bootstrap — Phase 4 (storage/04-server).
 *
 * Opens the server's standalone SQLite database (its own file, NOT the client
 * vault) and applies the authoritative schema (db/schema.sql) exactly once per
 * process. This is the seam the HTTP routes (routes/ops.ts) build on; it owns
 * the connection + schema, nothing more.
 *
 * Conventions mirror the core client DB (packages/core/src/db/index.ts):
 *   * WAL mode + a busy_timeout so the server tolerates the occasional write
 *     contention without erroring.
 *   * The schema file is located across deployment shapes (source, tsc build,
 *     Docker) by searching a small candidate list — the same trick core uses
 *     for its migrations directory.
 *   * `db.exec(schema)` is idempotent (all DDL is IF NOT EXISTS), so applying
 *     it to an existing database is a safe no-op.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * Locate db/schema.sql across the deployment shapes:
 *   * source run (vitest / tsx / dev):  src/db/schema.sql   (sibling of this file)
 *   * tsc build:                        dist/db/index.js    -> ../../src/db/schema.sql
 *   * Docker:                           WORKDIR=/app        -> packages/relay/src/db/schema.sql
 */
function resolveSchemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "schema.sql"),
    join(here, "..", "..", "src", "db", "schema.sql"),
    join(process.cwd(), "packages", "relay", "src", "db", "schema.sql"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `relay: could not locate db/schema.sql; tried:\n${candidates.join("\n")}`,
  );
}

/**
 * Open (creating the file and parent directory if needed) and apply the schema.
 *
 * Returns the configured Database. The caller owns the connection's lifetime
 * and calls `.close()`.
 */
export function openDatabase(dbPath: string): Database.Database {
  // Ensure the parent directory exists so a fresh /data volume works out of
  // the box (the Docker image mounts an empty /data).
  const dir = dirname(dbPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ops'").get();
  if (legacy) {
    const cols = db.prepare("PRAGMA table_info(ops)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "brain_id")) {
      db.close();
      throw new Error(`${dbPath} uses the pre-brains layout; delete the file to start fresh (brains are not migrated from it)`);
    }
  }

  const schema = readFileSync(resolveSchemaPath(), "utf-8");
  db.exec(schema);
  return db;
}
