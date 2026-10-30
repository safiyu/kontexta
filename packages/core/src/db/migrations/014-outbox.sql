-- 014-outbox.sql
-- Phase 3 (storage/03-outbox): local-first outbox + sync cursor + apply locks.
--
-- Goals:
--   1. An append-only `outbox` that every local write appends a discrete Op to
--      (spec 1.3). Ops transition pending -> sent -> acked, with `failed` as the
--      retryable side-state (attempt counter + exponential backoff). The sync
--      loop (Phase 4) drains pending ops in local-seq order; the server assigns
--      the authoritative global seq on ack.
--   2. A single-row `sync_cursor` holding the client's high-water mark into the
--      server's seq stream — the `since` value for GET /ops?since=<cursor>.
--   3. A cross-process advisory `sync_locks` table so that, when apps/mcp and
--      apps/web both apply incoming remote ops, only one process applies a given
--      gid at a time (spec 1.5). Mirrors journal_locks (006) but keyed on gid.
--
-- Conventions (see runner in src/db/index.ts + migrations 006 / 013):
--   * The runner wraps this file in a transaction; no BEGIN/COMMIT here.
--   * All statements are idempotent-safe: `IF NOT EXISTS` on DDL and `INSERT OR
--     IGNORE` for the seeded cursor row, so a re-run never errors or duplicates.
--   * Time columns are INTEGER milliseconds since epoch (matches journal_locks
--     .acquired_at and the Op.created_at contract), so they compare directly
--     against JS Date.now() with no unit conversion.
--   * No foreign keys: outbox.gid / sync_locks.gid are logical references to
--     records (which may live on another machine), not local row constraints.

-- 1. Append-only outbox. Every write mutation appends one row; the sync loop
--    never edits an op's identity fields, only its delivery state. The op's six
--    schema fields (spec 1.3) live in their own columns so the loop can filter
--    by status / order by local seq (id) / look up per-gid without decoding
--    every payload. `payload` holds the canonical JSON of op.payload (a null
--    payload is stored as the 4-char string "null", keeping the column NOT NULL).
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,   -- local append order (local seq)
  gid             TEXT    NOT NULL,                    -- <localId>@<machineId>
  kind            TEXT    NOT NULL,                    -- one of OP_KINDS
  origin          TEXT    NOT NULL,                    -- originating machine_id (16-hex)
  base_version    INTEGER,                             -- optimistic concurrency; NULL for create ops
  payload         TEXT    NOT NULL,                    -- canonical JSON of op.payload
  created_at      INTEGER NOT NULL,                    -- ms since epoch (informative; never for ordering)
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','acked','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),  -- retry counter
  next_attempt_at INTEGER,                             -- ms since epoch; when a failed op becomes retryable
  last_error      TEXT,                                -- last delivery failure reason (diagnostics)
  server_seq      INTEGER                              -- server-assigned global seq, set on ack
);

-- Draining pending ops in local-seq order is the hot path of the sync loop.
CREATE INDEX IF NOT EXISTS idx_outbox_status_id ON outbox(status, id);
-- Per-record lookups (re-assert / "keep-mine", conflict detection).
CREATE INDEX IF NOT EXISTS idx_outbox_gid ON outbox(gid);
-- Finding failed ops whose backoff window has elapsed.
CREATE INDEX IF NOT EXISTS idx_outbox_next_attempt ON outbox(next_attempt_at);

-- 2. Single-row polling cursor. `last_seq` is the highest server seq applied so
--    far; the next poll is GET /ops?since=<last_seq>. Seeded to 0 so the first
--    poll fetches the full history. `CHECK (id = 1)` enforces exactly one row.
CREATE TABLE IF NOT EXISTS sync_cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
INSERT OR IGNORE INTO sync_cursor (id, last_seq) VALUES (1, 0);

-- 3. Cross-process advisory lock for applying remote ops. One row per gid while
--    a process holds it. `expires_at` is an absolute ms-since-epoch deadline so
--    a crashed holder's lock is reclaimable when now >= expires_at (mirrors
--    journal_locks staleness, but as a fixed lease). Release must match `token`.
CREATE TABLE IF NOT EXISTS sync_locks (
  gid        TEXT    PRIMARY KEY,  -- the record being applied (one lock per gid)
  pid        INTEGER NOT NULL,     -- holder process id
  token      TEXT    NOT NULL,     -- ownership token; a release must match it
  expires_at INTEGER NOT NULL      -- ms since epoch; stale when now >= expires_at
);
