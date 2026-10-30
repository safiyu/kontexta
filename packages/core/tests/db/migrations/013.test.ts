import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDatabase, closeDatabase } from "../../../src/db/index.js";

// TDD contract for migration 013 (created in the following milestone). It runs
// RED today because the migration is absent: the runner-based tests fail (no
// `clients` / `gid` / `settings.machine_id` after 001..012) and the backfill
// tests fail (no `013-*.sql` file to replay). It turns GREEN once
// 013-clients-and-gids.sql lands and satisfies this contract.
const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/db/migrations -> up 3 to packages/core -> src/db/migrations.
const MIG_DIR = join(__dirname, "..", "..", "..", "src", "db", "migrations");

/**
 * Every syncable table, mapped to the PK column its gid backfill is keyed on.
 * journal_meta is the odd one out: its PK is `file_id` (not `id`), so the
 * migration must backfill `gid = file_id || '@' || machine_id` there.
 */
const GID_TABLES: ReadonlyArray<{ table: string; pk: string }> = [
  { table: "projects", pk: "id" },
  { table: "files", pk: "id" },
  { table: "tags", pk: "id" },
  { table: "calendar_entities", pk: "id" },
  { table: "calendar_events", pk: "id" },
  { table: "calendar_links", pk: "id" },
  { table: "journal_meta", pk: "file_id" },
];

const HEX16 = /^[0-9a-fA-F]{16}$/;

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
 * True if the table has any UNIQUE index (inline `UNIQUE` -> sqlite_autoindex,
 * or a named `CREATE UNIQUE INDEX`) whose column list includes `gid`.
 * Agnostic to how the migration expresses uniqueness.
 */
function hasUniqueGidIndex(db: Database.Database, table: string): boolean {
  const idxList = (db.prepare(`PRAGMA index_list(${table})`).all() as any[]).filter((i) => i.unique);
  for (const idx of idxList) {
    const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as any[]).map((c) => c.name);
    if (cols.includes("gid")) return true;
  }
  return false;
}

function machineIdFromSettings(db: Database.Database): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'machine_id'`).get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * A DB at the pre-013 state: 001..012 applied to a bare connection (bypassing
 * the runner's _migrations bookkeeping) so we can seed rows, then replay ONLY
 * 013 to prove its backfill. Returns the 013 filename (null if absent — red).
 */
function buildPre013Db(dbPath: string): { db: Database.Database; mig013: string | null } {
  const all = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const preFiles = all.filter((f) => !f.startsWith("013-"));
  const mig013 = all.find((f) => f.startsWith("013-")) ?? null;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const f of preFiles) {
    db.exec(readFileSync(join(MIG_DIR, f), "utf-8"));
  }
  return { db, mig013 };
}

/** Seed one row per syncable table (+ matching FTS rows) at a known state. */
function seedPre013(db: Database.Database): void {
  const TS = "2026-01-01T00:00:00Z";
  // SQL string literal (single-quoted). JSON.stringify would emit double quotes,
  // which SQLite treats as identifiers and rejects.
  const TSq = `'${TS}'`;
  db.exec(`
    INSERT INTO projects (id, name, slug) VALUES (1, 'proj-a', 'proj-a'), (2, 'proj-b', 'proj-b');

    INSERT INTO files (id, path, title, project_id, storage_type)
      VALUES (1, '/kb/a/f1.md', 'F1', 1, 'local'), (2, '/kb/a/f2.md', 'F2', 1, 'local');

    -- FTS rows keyed by files.id (the rowid invariant under test).
    INSERT INTO fts_index (rowid, title, content)
      VALUES (1, 'F1', 'alpha beta'), (2, 'F2', 'gamma delta');

    INSERT INTO tags (id, name) VALUES (1, 'alpha'), (2, 'beta');

    INSERT INTO calendar_entities (id, name, created_at, updated_at)
      VALUES (1, 'server-1', ${TSq}, ${TSq}),
             (2, 'server-2', ${TSq}, ${TSq});

    INSERT INTO calendar_events (id, entity_id, type, title, starts_at, ends_at, created_at, updated_at)
      VALUES (1, 1, 'downtime', 'down', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
              ${TSq}, ${TSq});

    INSERT INTO calendar_links (id, from_entity_id, to_entity_id, created_at)
      VALUES (1, 1, 2, ${TSq});

    INSERT INTO journal_meta (file_id, project_id, task_slug, started_at, last_active_at)
      VALUES (1, 1, 'task-x', ${TSq}, ${TSq});
  `);
}

describe("Migration 013: clients table + global IDs (gid)", () => {
  let testDir: string;
  const tempDbs: string[] = [];
  const bareConns: Database.Database[] = [];

  const mkDbPath = (): string => {
    if (!testDir) testDir = mkdtempSync(join(tmpdir(), "kontexta-mig013-"));
    const p = join(testDir, `${tempDbs.length + 1}.db`);
    tempDbs.push(p);
    return p;
  };

  afterEach(() => {
    // Close bare connections opened for the 013-replay tests (not the singleton).
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
    it("creates the clients table with an identity key, hostname, and last-seen timestamp", () => {
      const db = createDatabase(mkDbPath());
      expect(tableExists(db, "clients"), "clients table must exist").toBe(true);

      const cols = tableColumns(db, "clients");
      expect(cols, "clients must key on machine_id").toContain("machine_id");
      expect(cols, "clients must record the connecting hostname").toContain("hostname");
      expect(
        cols.some((c) => /last|seen|connect|active|update/i.test(c)),
        `clients must carry a last-seen/updated timestamp (got: ${cols.join(", ")})`,
      ).toBe(true);
    });

    it("records machine_id as a unique key on clients (upsert, not duplicate)", () => {
      const db = createDatabase(mkDbPath());
      const cols = tableColumns(db, "clients");
      expect(cols).toContain("machine_id");

      const pkCols = (db.prepare(`PRAGMA table_info(clients)`).all() as any[]).filter((c) => c.pk > 0);
      const isPk = pkCols.some((c) => c.name === "machine_id");
      const uniqueIdx = (db.prepare(`PRAGMA index_list(clients)`).all() as any[]).some((i) => i.unique);
      expect(isPk || uniqueIdx, "machine_id must be a primary key or part of a unique index").toBe(
        true,
      );
    });

    it("seeds a stable 16-hex settings.machine_id and a machine_label (single row each)", () => {
      const db = createDatabase(mkDbPath());
      const mid = machineIdFromSettings(db);
      expect(mid, "settings.machine_id must be seeded").toBeTruthy();
      expect(HEX16.test(mid ?? ""), `machine_id must be 16 hex chars (got: ${mid})`).toBe(true);

      const label = (db.prepare(`SELECT value FROM settings WHERE key = 'machine_label'`).get() as
        | { value: string }
        | undefined)?.value;
      expect(label, "settings.machine_label must be seeded (may be empty)").toBeDefined();

      const midRows = (db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key='machine_id'`).get() as
        | { n: number }).n;
      expect(midRows, "settings.machine_id must be a single row").toBe(1);
    });

    it("adds a gid column to every syncable table", () => {
      const db = createDatabase(mkDbPath());
      for (const { table } of GID_TABLES) {
        const cols = tableColumns(db, table);
        expect(cols, `${table} must gain a gid column (has: ${cols.join(", ")})`).toContain("gid");
      }
    });

    it("enforces a UNIQUE index on gid for every syncable table", () => {
      const db = createDatabase(mkDbPath());
      for (const { table } of GID_TABLES) {
        expect(hasUniqueGidIndex(db, table), `${table}.gid must be uniquely indexed`).toBe(true);
      }
    });
  });

  describe("backfill + FTS alignment (013 replayed over seeded data)", () => {
    it("replays over pre-013 data and backfills gid = <pk>@<machine_id>", () => {
      const { db, mig013 } = buildPre013Db(mkDbPath());
      bareConns.push(db);
      expect(mig013, "a 013-*.sql migration must exist").toBeTruthy();

      seedPre013(db);
      db.exec(readFileSync(join(MIG_DIR, mig013!), "utf-8"));

      const machineId = machineIdFromSettings(db);
      expect(machineId, "machine_id must be seeded by 013").toBeTruthy();
      expect(HEX16.test(machineId!)).toBe(true);

      for (const { table, pk } of GID_TABLES) {
        const rows = (db.prepare(`SELECT ${pk} AS pk, gid FROM ${table}`).all() as any[]).filter(
          (r) => r.pk != null,
        );
        expect(rows.length, `${table} should have seeded rows to backfill`).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.gid, `${table}.${pk}=${r.pk} must be backfilled, not NULL`).toBe(
            `${r.pk}@${machineId}`,
          );
        }
      }
    });

    it("preserves FTS5 rowid alignment and integer PKs after adding gid", () => {
      const { db, mig013 } = buildPre013Db(mkDbPath());
      bareConns.push(db);
      expect(mig013, "a 013-*.sql migration must exist").toBeTruthy();

      seedPre013(db);
      // Capture pre-migration integer PKs to prove 013 did not renumber them.
      const idsBefore = (db.prepare(`SELECT id FROM files ORDER BY id`).all() as any[]).map(
        (r) => r.id,
      );
      const ftsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM fts_index`).get() as { n: number }).n;

      db.exec(readFileSync(join(MIG_DIR, mig013!), "utf-8"));

      // files.id must be unchanged (gid is a secondary column, not a PK swap).
      const idsAfter = (db.prepare(`SELECT id FROM files ORDER BY id`).all() as any[]).map(
        (r) => r.id,
      );
      expect(idsAfter).toEqual(idsBefore);

      // No fts_index row may point at a missing files.id (no orphans/drift).
      const orphans = (
        db.prepare(
          `SELECT COUNT(*) AS n FROM fts_index f WHERE NOT EXISTS (SELECT 1 FROM files x WHERE x.id = f.rowid)`,
        ).get() as { n: number }
      ).n;
      expect(orphans, "no fts_index row may point at a missing files.id").toBe(0);

      const ftsAfter = (db.prepare(`SELECT COUNT(*) AS n FROM fts_index`).get() as { n: number }).n;
      expect(ftsAfter, "fts_index row count must be untouched by 013").toBe(ftsBefore);

      // The exact join the search path relies on (files.id = fts_index.rowid) still matches.
      const joined = (
        db.prepare(`SELECT x.id FROM fts_index f JOIN files x ON x.id = f.rowid ORDER BY x.id`).all() as any[]
      ).map((r) => r.id);
      expect(joined).toEqual([1, 2]);
    });
  });
});
