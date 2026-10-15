import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDatabase, closeDatabase } from "../../../src/db/index.js";

// TDD contract for migration 014 (outbox / sync_cursor / sync_locks). It runs
// RED today because the migration is absent: the runner-based tests fail (no
// `outbox` / `sync_cursor` / `sync_locks` after 001..013). It turns GREEN once
// 014-outbox.sql lands and satisfies this contract.
const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/db/migrations -> up 3 to packages/core -> src/db/migrations.
const MIG_DIR = join(__dirname, "..", "..", "..", "src", "db", "migrations");

/** The three out-of-band delivery states the spec's state machine permits. */
const OUTBOX_STATUSES = ["pending", "sent", "acked", "failed"];

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(table);
  return row !== undefined;
}

/**
 * True iff `table` has an index whose column list includes every column in
 * `want` (in that order). Agnostic to whether it's a UNIQUE index or named.
 */
function hasIndexOn(db: Database.Database, table: string, want: string[]): boolean {
  const idxList = db.prepare(`PRAGMA index_list(${table})`).all() as any[];
  for (const idx of idxList) {
    const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as any[]).map((c) => c.name);
    if (want.every((c) => cols.includes(c))) return true;
  }
  return false;
}

/**
 * True iff `table` has a CHECK constraint (or any DDL text in sqlite_master)
 * mentioning a given fragment — used to pin the outbox status whitelist without
 * over-specifying the exact clause wording.
 */
function schemaMentions(db: Database.Database, table: string, fragment: string): boolean {
  const ddl = (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
      .get(table) as { sql: string } | undefined
  )?.sql ?? "";
  return ddl.includes(fragment);
}

/**
 * A DB at the pre-014 state: 001..013 applied to a bare connection (bypassing
 * the runner's _migrations bookkeeping) so we can seed rows, then replay ONLY
 * 014. Returns the 014 filename (null if absent — red).
 */
function buildPre014Db(dbPath: string): { db: Database.Database; mig014: string | null } {
  const all = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const preFiles = all.filter((f) => !f.startsWith("014-"));
  const mig014 = all.find((f) => f.startsWith("014-")) ?? null;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const f of preFiles) {
    db.exec(readFileSync(join(MIG_DIR, f), "utf-8"));
  }
  return { db, mig014 };
}

describe("Migration 014: outbox + sync_cursor + sync_locks", () => {
  let testDir: string;
  const tempDbs: string[] = [];
  const bareConns: Database.Database[] = [];

  const mkDbPath = (): string => {
    if (!testDir) testDir = mkdtempSync(join(tmpdir(), "kontexta-mig014-"));
    const p = join(testDir, `${tempDbs.length + 1}.db`);
    tempDbs.push(p);
    return p;
  };

  afterEach(() => {
    // Close bare connections opened for the 014-replay tests (not the singleton).
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
    it("creates the outbox table carrying the Op schema + delivery state", () => {
      const db = createDatabase(mkDbPath());
      expect(tableExists(db, "outbox"), "outbox table must exist").toBe(true);

      const cols = tableColumns(db, "outbox");
      // The six Op schema fields (spec 1.3) + local seq + delivery state.
      for (const c of ["gid", "kind", "origin", "base_version", "payload", "created_at"]) {
        expect(cols, `outbox must carry the Op field ${c} (has: ${cols.join(", ")})`).toContain(c);
      }
      // Delivery state machine: status + retry accounting.
      for (const c of ["status", "attempts"]) {
        expect(cols, `outbox must carry delivery-state column ${c}`).toContain(c);
      }
    });

    it("constrains outbox.status to the known state-machine values", () => {
      const db = createDatabase(mkDbPath());
      // A CHECK (or equivalent) must whitelist exactly the four states — pin at
      // least that the DDL references the terminal 'acked' state and rejects a
      // nonsense status at the SQLite level (not merely in app code).
      expect(schemaMentions(db, "outbox", "acked"), "outbox status DDL must reference 'acked'").toBe(
        true,
      );
      expect(
        () =>
          db
            .prepare(
              "INSERT INTO outbox (gid, kind, origin, payload, created_at, status) VALUES ('1@4f9e1a8b3c7d2e0f','file.update','4f9e1a8b3c7d2e0f','{}',1,'bogus-state')",
            )
            .run(),
        "an outbox status outside the state machine must be rejected by the schema",
      ).toThrow();
      // ...while a legal status inserts cleanly.
      const n = db
        .prepare(
          "INSERT INTO outbox (gid, kind, origin, payload, created_at, status) VALUES ('1@4f9e1a8b3c7d2e0f','file.update','4f9e1a8b3c7d2e0f','{}',1,'pending')",
        )
        .run();
      expect(n.changes, "a 'pending' outbox row must insert").toBe(1);
    });

    it("indexes the outbox for the sync loop's drain + per-gid lookups", () => {
      const db = createDatabase(mkDbPath());
      // The hot path: pending ops in local-seq order. Must have (status, id).
      expect(
        hasIndexOn(db, "outbox", ["status", "id"]),
        "outbox must index (status, id) to drain pending ops in order",
      ).toBe(true);
      // Per-record lookups (re-assert / conflict detection) must index gid.
      expect(hasIndexOn(db, "outbox", ["gid"]), "outbox must index gid").toBe(true);
    });

    it("creates a single-row sync_cursor seeded to 0 (the polling since-cursor)", () => {
      const db = createDatabase(mkDbPath());
      expect(tableExists(db, "sync_cursor"), "sync_cursor table must exist").toBe(true);

      const cols = tableColumns(db, "sync_cursor");
      expect(cols, "sync_cursor must carry last_seq").toContain("last_seq");

      const rows = db.prepare("SELECT id, last_seq FROM sync_cursor").all() as any[];
      expect(rows.length, "sync_cursor must hold exactly one row").toBe(1);
      expect(rows[0].last_seq, "the seed cursor must start at 0").toBe(0);

      // The one-row invariant must be enforced by the schema, not app code.
      expect(
        () => db.prepare("INSERT INTO sync_cursor (id, last_seq) VALUES (2, 0)").run(),
        "a second sync_cursor row must be rejected by the schema",
      ).toThrow();
    });

    it("creates sync_locks keyed on gid for cross-process apply safety", () => {
      const db = createDatabase(mkDbPath());
      expect(tableExists(db, "sync_locks"), "sync_locks table must exist").toBe(true);

      const cols = tableColumns(db, "sync_locks");
      for (const c of ["gid", "pid", "token", "expires_at"]) {
        expect(cols, `sync_locks must carry column ${c} (has: ${cols.join(", ")})`).toContain(c);
      }

      // One lock per gid: a second lock on the same gid must be rejected.
      db.prepare("INSERT INTO sync_locks (gid, pid, token, expires_at) VALUES ('1@4f9e1a8b3c7d2e0f', 111, 'tok-a', 9999)").run();
      expect(
        () =>
          db.prepare("INSERT INTO sync_locks (gid, pid, token, expires_at) VALUES ('1@4f9e1a8b3c7d2e0f', 222, 'tok-b', 9999)").run(),
        "a second lock on the same gid must be rejected (one holder per gid)",
      ).toThrow();
      // ...but a lock on a different gid is fine.
      db.prepare("INSERT INTO sync_locks (gid, pid, token, expires_at) VALUES ('2@4f9e1a8b3c7d2e0f', 222, 'tok-c', 9999)").run();
    });
  });

  describe("014 replayed over seeded pre-014 data (idempotency + isolation)", () => {
    it("replays cleanly and does not disturb existing 001..013 rows", () => {
      const { db, mig014 } = buildPre014Db(mkDbPath());
      bareConns.push(db);
      expect(mig014, "a 014-*.sql migration must exist").toBeTruthy();

      // Seed a file + its gid (as 013 backfilled it) so we can assert 014 left
      // the pre-existing schema/data untouched. (SQL string literal, not
      // JSON.stringify: double quotes would be read as identifiers.)
      const machineId = (
        db.prepare("SELECT value FROM settings WHERE key = 'machine_id'").get() as { value: string }
      ).value;
      db.exec(`
        INSERT INTO projects (id, name, slug) VALUES (1, 'proj-a', 'proj-a');
        INSERT INTO files (id, path, title, project_id, storage_type)
          VALUES (1, '/kb/a/f1.md', 'F1', 1, 'local');
        UPDATE files SET gid = '1@${machineId}' WHERE id = 1;
      `);

      const filesBefore = (db.prepare("SELECT id, gid FROM files ORDER BY id").all() as any[]).map(
        (r) => r.id,
      );
      const gidBefore = (db.prepare("SELECT gid FROM files WHERE id = 1").get() as { gid: string }).gid;

      db.exec(readFileSync(join(MIG_DIR, mig014!), "utf-8"));

      // 014 must not renumber files.id or clobber the 013 backfilled gid.
      const filesAfter = (db.prepare("SELECT id, gid FROM files ORDER BY id").all() as any[]).map(
        (r) => r.id,
      );
      expect(filesAfter, "014 must not renumber files.id").toEqual(filesBefore);
      expect(
        (db.prepare("SELECT gid FROM files WHERE id = 1").get() as { gid: string }).gid,
        "014 must not clobber the 013 backfilled gid",
      ).toBe(gidBefore);

      // The new tables are now present and the outbox is empty (nothing seeded).
      expect(tableExists(db, "outbox")).toBe(true);
      expect((db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM sync_cursor").get() as { n: number }).n,
        "exactly one cursor row after replay",
      ).toBe(1);
    });

    it("is idempotent: re-running 014 does not duplicate or error", () => {
      const { db, mig014 } = buildPre014Db(mkDbPath());
      bareConns.push(db);
      expect(mig014, "a 014-*.sql migration must exist").toBeTruthy();

      const sql = readFileSync(join(MIG_DIR, mig014!), "utf-8");
      db.exec(sql);
      const cursorCount = (db.prepare("SELECT COUNT(*) AS n FROM sync_cursor").get() as { n: number }).n;

      // A second application must be a no-op: no duplicate cursor row, no error.
      expect(() => db.exec(sql), "re-running 014 must not throw").not.toThrow();
      const cursorCountAgain = (db.prepare("SELECT COUNT(*) AS n FROM sync_cursor").get() as { n: number }).n;
      expect(cursorCountAgain, "re-running 014 must not add a second cursor row").toBe(cursorCount);
      expect(cursorCountAgain).toBe(1);
    });
  });
});
