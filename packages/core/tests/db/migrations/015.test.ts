import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDatabase, closeDatabase } from "../../../src/db/index.js";

// TDD contract for migration 015 (endpoint config in `settings`). It runs RED
// today because the migration is absent: the runner-based tests fail (the
// endpoint_* / poll_*_interval_ms settings rows are missing after 001..014).
// It turns GREEN once 015-endpoint-config.sql lands and satisfies this
// contract.
const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/db/migrations -> up 3 to packages/core -> src/db/migrations.
const MIG_DIR = join(__dirname, "..", "..", "..", "src", "db", "migrations");

/** The poll cadence keys seeded by 015 (migration 018 replaced endpoint_url/endpoint_token with the brain settings). */
const ENDPOINT_DEFAULTS: ReadonlyArray<{ key: string; value: string }> = [
  // Spec 1.6: 15 s active poll, 60 s idle poll.
  { key: "poll_active_interval_ms", value: "15000" },
  { key: "poll_idle_interval_ms", value: "60000" },
];

function settingValue(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * A DB at the pre-015 state: 001..014 applied to a bare connection (bypassing
 * the runner's _migrations bookkeeping) so we can seed rows, then replay ONLY
 * 015. Returns the 015 filename (null if absent — red).
 */
function buildPre015Db(dbPath: string): { db: Database.Database; mig015: string | null } {
  const all = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const preFiles = all.filter((f) => !f.startsWith("015-"));
  const mig015 = all.find((f) => f.startsWith("015-")) ?? null;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const f of preFiles) {
    db.exec(readFileSync(join(MIG_DIR, f), "utf-8"));
  }
  return { db, mig015 };
}

describe("Migration 015: endpoint config settings", () => {
  let testDir: string;
  const tempDbs: string[] = [];
  const bareConns: Database.Database[] = [];

  const mkDbPath = (): string => {
    if (!testDir) testDir = mkdtempSync(join(tmpdir(), "kontexta-mig015-"));
    const p = join(testDir, `${tempDbs.length + 1}.db`);
    tempDbs.push(p);
    return p;
  };

  afterEach(() => {
    // Close bare connections opened for the 015-replay tests (not the singleton).
    for (const c of bareConns) {
      try {
        c.pragma("wal_checkpoint(TRUNCATE)");
        c.close();
      } catch {}
    }
    bareConns.length = 0;
    closeDatabase(); // clear the shared singleton (if a runner-based test opened it)
    for (const p of tempDbs) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(p + suffix, { force: true });
        } catch {}
      }
    }
    tempDbs.length = 0;
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = "";
    }
  });

  describe("via the migration runner", () => {
    it("seeds the two poll-cadence settings rows with disconnected/idle defaults", () => {
      const db = createDatabase(mkDbPath());
      for (const { key, value } of ENDPOINT_DEFAULTS) {
        expect(settingValue(db, key), `settings.${key} must be seeded`).not.toBeNull();
        expect(
          settingValue(db, key),
          `settings.${key} must default to ${JSON.stringify(value)}`,
        ).toBe(value);
      }
    });

    it("seeds the poll intervals as the spec 1.6 cadence (15000/60000 ms, parseable ints)", () => {
      const db = createDatabase(mkDbPath());
      const active = settingValue(db, "poll_active_interval_ms");
      const idle = settingValue(db, "poll_idle_interval_ms");
      expect(Number(active), "active interval must be a positive integer ms value").toBe(15000);
      expect(Number(idle), "idle interval must be a positive integer ms value").toBe(60000);
      expect(Number(idle), "idle interval must be >= active interval").toBeGreaterThanOrEqual(
        Number(active),
      );
    });

    it("seeds a non-empty updated_at (the settings table's own timestamp column)", () => {
      const db = createDatabase(mkDbPath());
      const rows = db
        .prepare(
          "SELECT key, updated_at FROM settings WHERE key IN ('poll_active_interval_ms','poll_idle_interval_ms')",
        )
        .all() as Array<{ key: string; updated_at: string }>;
      expect(rows.length, "exactly two poll settings rows").toBe(2);
      for (const r of rows) {
        expect(r.updated_at, `settings.${r.key}.updated_at must be set`).toBeTruthy();
        expect(new Date(r.updated_at).getTime(), "updated_at must be parseable").not.toBeNaN();
      }
    });

    it("does not add any new tables (the settings key/value store is reused)", () => {
      const db = createDatabase(mkDbPath());
      // 015 is a settings-only migration: the only storage is the 005 `settings`
      // table. Pin that no endpoint/poll-named table sneaked in.
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(
        tables.filter((t) => /endpoint|poll/i.test(t)),
        "015 must not create endpoint/poll tables",
      ).toEqual([]);
      expect(tables, "settings table must exist").toContain("settings");
    });
  });

  describe("015 replayed over seeded pre-015 data (idempotency + no clobber)", () => {
    it("replays cleanly and does not disturb existing 001..014 rows", () => {
      const { db, mig015 } = buildPre015Db(mkDbPath());
      bareConns.push(db);
      expect(mig015, "a 015-*.sql migration must exist").toBeTruthy();

      // Seed a file + its gid (as 013 backfilled it) plus a pre-existing
      // setting, so we can assert 015 left pre-existing data untouched.
      const machineId = (
        db.prepare("SELECT value FROM settings WHERE key = 'machine_id'").get() as { value: string }
      ).value;
      db.exec(`
        INSERT INTO projects (id, name, slug) VALUES (1, 'proj-a', 'proj-a');
        INSERT INTO files (id, path, title, project_id, storage_type)
          VALUES (1, '/kb/a/f1.md', 'F1', 1, 'local');
        UPDATE files SET gid = '1@${machineId}' WHERE id = 1;
        INSERT INTO settings (key, value, updated_at) VALUES ('some_other_key', 'keep-me', datetime('now'));
      `);

      const gidBefore = (db.prepare("SELECT gid FROM files WHERE id = 1").get() as { gid: string }).gid;
      const settingsBefore = (
        db.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{
          key: string;
          value: string;
        }>
      ).length;

      db.exec(readFileSync(join(MIG_DIR, mig015!), "utf-8"));

      // 015 must not touch files or any pre-existing setting value.
      expect(
        (db.prepare("SELECT gid FROM files WHERE id = 1").get() as { gid: string }).gid,
        "015 must not clobber the 013 backfilled gid",
      ).toBe(gidBefore);
      expect(
        settingValue(db, "some_other_key"),
        "015 must not clobber unrelated settings",
      ).toBe("keep-me");
      // Exactly the four new rows were added — no more, no fewer.
      const settingsAfter = (
        db.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{
          key: string;
          value: string;
        }>
      ).length;
      expect(settingsAfter, "015 must add exactly four settings rows").toBe(settingsBefore + 4);
    });

    it("is idempotent: re-running 015 does not duplicate or error", () => {
      const { db, mig015 } = buildPre015Db(mkDbPath());
      bareConns.push(db);
      expect(mig015, "a 015-*.sql migration must exist").toBeTruthy();

      const sql = readFileSync(join(MIG_DIR, mig015!), "utf-8");
      db.exec(sql);
      const countAfterFirst = (
        db.prepare(
          "SELECT COUNT(*) AS n FROM settings WHERE key IN ('endpoint_url','endpoint_token','poll_active_interval_ms','poll_idle_interval_ms')",
        ).get() as { n: number }
      ).n;
      expect(countAfterFirst).toBe(4);

      // A second application must be a no-op: no duplicate rows, no error
      // (settings.key is the PRIMARY KEY, so duplicates are impossible, but the
      // file must not throw either).
      expect(() => db.exec(sql), "re-running 015 must not throw").not.toThrow();
      const countAfterSecond = (
        db.prepare(
          "SELECT COUNT(*) AS n FROM settings WHERE key IN ('endpoint_url','endpoint_token','poll_active_interval_ms','poll_idle_interval_ms')",
        ).get() as { n: number }
      ).n;
      expect(countAfterSecond, "re-running 015 must not add rows").toBe(4);
    });

    it("never clobbers a user-configured endpoint on replay (INSERT OR IGNORE, not OR REPLACE)", () => {
      const { db, mig015 } = buildPre015Db(mkDbPath());
      bareConns.push(db);
      expect(mig015, "a 015-*.sql migration must exist").toBeTruthy();

      // Simulate a machine that has already run `kontexta endpoint connect`
      // (the CLI/M69 writes these via setSetting's upsert).
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('endpoint_url', 'https://store.example.com', datetime('now'))").run();
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('endpoint_token', 'tok-abc123', datetime('now'))").run();
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('poll_active_interval_ms', '30000', datetime('now'))").run();

      // Replaying the migration (e.g. a fresh process boot that re-runs DDL)
      // must preserve the user's configured values, not reset them to defaults.
      db.exec(readFileSync(join(MIG_DIR, mig015!), "utf-8"));

      expect(settingValue(db, "endpoint_url")).toBe("https://store.example.com");
      expect(settingValue(db, "endpoint_token")).toBe("tok-abc123");
      expect(settingValue(db, "poll_active_interval_ms")).toBe("30000");
      // A key the user deleted (disconnect) is re-seeded by the replay.
      db.prepare("DELETE FROM settings WHERE key = 'poll_idle_interval_ms'").run();
      db.exec(readFileSync(join(MIG_DIR, mig015!), "utf-8"));
      expect(settingValue(db, "poll_idle_interval_ms")).toBe("60000");
    });
  });
});
