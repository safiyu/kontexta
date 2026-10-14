-- 013-clients-and-gids.sql
-- Phase 2 (storage/02-ids): machine identity + global IDs (gid).
--
-- Goals:
--   1. A `clients` registry so a vault can show which machines have connected.
--   2. A stable per-machine identity, `settings.machine_id`, generated ONCE as
--      a 16-hex string and persisted for the life of the vault.
--   3. A `gid` (global id) on every syncable record, formatted
--      `<local_pk>@<machine_id>`, uniquely indexed. Integer PKs are preserved
--      untouched so FTS5 `rowid` stays aligned with `files.id`.
--
-- Conventions (see runner in src/db/index.ts + migration 008):
--   * The runner wraps this file in a transaction; no BEGIN/COMMIT here.
--   * SQLite forbids `ALTER TABLE ... ADD COLUMN ... UNIQUE`, so `gid` is added
--     as a plain nullable column, uniquely indexed separately, then backfilled.
--     (A UNIQUE index treats NULLs as distinct, so the all-NULL pre-backfill
--     state is legal and the backfill values — unique per pk — validate cleanly.)
--   * All statements are idempotent-safe: `IF NOT EXISTS` on DDL, `INSERT OR
--     IGNORE` for settings, and `WHERE gid IS NULL` on backfills.

-- 1. Clients registry. `machine_id` is the identity key (one row per machine);
--    `hostname` records where it last connected; the *_seen_at columns bound
--    first/last contact for recency display.
CREATE TABLE IF NOT EXISTS clients (
  machine_id    TEXT PRIMARY KEY,
  hostname      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen_at DESC);

-- 2. Seed the stable machine identity (once). `randomblob(8)` -> 8 random bytes
--    -> hex() -> 16 chars; lower() matches the gid example format
--    (`104@4f9e1a8b3c7d2e0f`). `INSERT OR IGNORE` keeps it stable across runs.
INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES ('machine_id', lower(hex(randomblob(8))), datetime('now'));

-- Human-readable label for conflict-copy naming ("<name> (from <label>).ext").
-- Seeded empty; the app layer (machine.ts) owns populating it with a hostname.
INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES ('machine_label', '', datetime('now'));

-- 3. Add the gid column to every syncable table (nullable; backfilled below).
ALTER TABLE projects           ADD COLUMN gid TEXT;
ALTER TABLE files              ADD COLUMN gid TEXT;
ALTER TABLE tags               ADD COLUMN gid TEXT;
ALTER TABLE calendar_entities  ADD COLUMN gid TEXT;
ALTER TABLE calendar_events    ADD COLUMN gid TEXT;
ALTER TABLE calendar_links     ADD COLUMN gid TEXT;
ALTER TABLE journal_meta       ADD COLUMN gid TEXT;

-- 4. Unique index per table. journal_meta keys on file_id (its PK), the rest on id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_gid           ON projects(gid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_gid              ON files(gid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_gid               ON tags(gid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_entities_gid  ON calendar_entities(gid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_gid    ON calendar_events(gid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_links_gid     ON calendar_links(gid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_meta_gid       ON journal_meta(gid);

-- 5. Backfill existing rows: gid = <pk>@<machine_id>. `WHERE gid IS NULL` keeps
--    it idempotent and never clobbers a gid a later write may already have set.
UPDATE projects SET gid = CAST(id AS TEXT) || '@' || (SELECT value FROM settings WHERE key = 'machine_id')
  WHERE gid IS NULL;

UPDATE files SET gid = CAST(id AS TEXT) || '@' || (SELECT value FROM settings WHERE key = 'machine_id')
  WHERE gid IS NULL;

UPDATE tags SET gid = CAST(id AS TEXT) || '@' || (SELECT value FROM settings WHERE key = 'machine_id')
  WHERE gid IS NULL;

UPDATE calendar_entities SET gid = CAST(id AS TEXT) || '@' || (SELECT value FROM settings WHERE key = 'machine_id')
  WHERE gid IS NULL;

UPDATE calendar_events SET gid = CAST(id AS TEXT) || '@' || (SELECT value FROM settings WHERE key = 'machine_id')
  WHERE gid IS NULL;

UPDATE calendar_links SET gid = CAST(id AS TEXT) || '@' || (SELECT value FROM settings WHERE key = 'machine_id')
  WHERE gid IS NULL;

UPDATE journal_meta SET gid = CAST(file_id AS TEXT) || '@' || (SELECT value FROM settings WHERE key = 'machine_id')
  WHERE gid IS NULL;
