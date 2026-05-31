/**
 * Database module for Kontexta
 * Manages SQLite database connection, migrations, and singleton pattern
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDbPath, ensureDataDir } from "../util/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Locate the SQL migrations directory across deployment shapes:
// - tsc build: dist/db/migrations (sibling of this file)
// - Next.js standalone: src files traced to monorepo-relative paths under /app
// - Next.js standalone with cwd in apps/web: walk up two levels
function resolveMigrationsDir(): string {
  const candidates = [
    // Docker: WORKDIR=/app, migrations explicitly copied to /app/packages/core/src/db/migrations
    join(process.cwd(), "packages", "core", "src", "db", "migrations"),
    // tsc build: dist/db/migrations (sibling of this file's dist location)
    join(__dirname, "migrations"),
    // Next.js standalone: __dirname resolves relative to the traced module
    join(__dirname, "..", "..", "src", "db", "migrations"),
    // Fallback: dist copy
    join(process.cwd(), "packages", "core", "dist", "db", "migrations"),
    join(process.cwd(), "..", "..", "packages", "core", "src", "db", "migrations"),
    join(process.cwd(), "..", "..", "packages", "core", "dist", "db", "migrations"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `migrations directory not found. Checked:\n- ${candidates.join("\n- ")}`
  );
}

// globalThis-cached so Next.js HMR / module duplication doesn't orphan
// the handle and leave WAL/SHM files locked.
declare global {
  // eslint-disable-next-line no-var
  var __kontextaDb: Database.Database | null | undefined;
  // eslint-disable-next-line no-var
  var __kontextaDbCloseRegistered: boolean | undefined;
  // eslint-disable-next-line no-var
  var __kontextaTmpSessionSecret: string | undefined;
}

let db: Database.Database | null = globalThis.__kontextaDb ?? null;

/**
 * Create and initialize the database
 * @param dbPath - Path to the SQLite database file
 * @returns Database instance
 */
export function createDatabase(dbPath: string): Database.Database {
  if (db) {
    return db;
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  globalThis.__kontextaDb = db;

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations();

  if (!globalThis.__kontextaDbCloseRegistered) {
    globalThis.__kontextaDbCloseRegistered = true;
    const close = () => {
      try {
        closeDatabase();
      } catch {}
    };
    process.once("beforeExit", close);
    // Brief drain window so in-flight requests can finish their DB work
    // before we yank the connection out from under them.
    const SHUTDOWN_DRAIN_MS = Number(process.env.KONTEXTA_SHUTDOWN_DRAIN_MS ?? 1500);
    const gracefulExit = (signal: string) => {
      console.error(`[Database] ${signal} received, draining for ${SHUTDOWN_DRAIN_MS}ms before close`);
      setTimeout(() => {
        close();
        process.exit(0);
      }, SHUTDOWN_DRAIN_MS);
    };
    process.once("SIGINT", () => gracefulExit("SIGINT"));
    process.once("SIGTERM", () => gracefulExit("SIGTERM"));
  }

  return db;
}

/**
 * Get the existing database instance
 * @returns Database instance
 * @throws Error if database is not initialized
 */
export function getDatabase(): Database.Database {
  if (!db) {
    ensureDataDir();
    return createDatabase(getDbPath());
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    // Force checkpoint WAL so writes are visible to other connections/processes
    // that open the same database file (critical for Docker MCP → Web UI sharing).
    try { db.pragma("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    db.close();
    db = null;
    globalThis.__kontextaDb = null;
  }
}

/**
 * Graceful shutdown: stop accepting new work, drain in-flight ops with a
 * hard ceiling, then close the database. Returns the count of operations
 * that were still in-flight when the timeout elapsed (0 = clean drain).
 */
export async function gracefulShutdown(timeoutMs: number = 10_000): Promise<number> {
  const { setShuttingDown, awaitDrain } = await import("../util/safety.js");
  setShuttingDown(true);
  const remaining = await awaitDrain(timeoutMs);
  closeDatabase();
  return remaining;
}

/**
 * Run all pending migrations
 */
export function runMigrations(): void {
  if (!db) {
    throw new Error("Database not initialized. Call createDatabase() first.");
  }

  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = resolveMigrationsDir();

  // Get all .sql files and sort them
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const getMigrationStmt = db.prepare("SELECT id FROM _migrations WHERE name = ?");
  const insertMigrationStmt = db.prepare("INSERT INTO _migrations (name) VALUES (?)");

  // Execute each migration in order
  for (const file of migrationFiles) {
    const isExecuted = getMigrationStmt.get(file);

    if (!isExecuted) {
      const migrationPath = join(migrationsDir, file);
      const sql = readFileSync(migrationPath, "utf-8");

      // We wrap the .sql in a JS-side transaction; an inner BEGIN/COMMIT
      // would conflict with that and leave the migration partially applied
      // with no _migrations row, causing a permanent re-run loop on boot.
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im.test(sql)) {
        throw new Error(
          `Migration ${file} contains BEGIN/COMMIT/ROLLBACK; remove it (the migration runner already wraps in a transaction).`
        );
      }

      console.error(`[Database] Running migration: ${file}`);

      // Execute the migration in a transaction
      db.transaction(() => {
        db!.exec(sql);
        insertMigrationStmt.run(file);
      })();
    }
  }
}
