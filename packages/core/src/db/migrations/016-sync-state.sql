-- 016-sync-state.sql
-- Per-gid server version this machine has seen, and ops the pull could not apply.

-- The version a gid had on the server after the last op this machine acked or pulled; sent as base_version.
CREATE TABLE IF NOT EXISTS gid_versions (
  gid     TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

-- Remote ops that failed to apply: retried a few ticks, then skipped (and kept here) so one bad op cannot pin the cursor.
CREATE TABLE IF NOT EXISTS sync_skipped_ops (
  seq        INTEGER PRIMARY KEY,
  gid        TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  origin     TEXT    NOT NULL,
  error      TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 1,
  skipped    INTEGER NOT NULL DEFAULT 0,  -- 1 = given up on; 0 = still retrying
  created_at INTEGER NOT NULL
);
