-- schema.sql
-- kontexta-brain-host: one server, many fully separate brains.
-- Every table is scoped by brain_id; nothing is ever pruned (a brain remembers everything).
-- Time columns are INTEGER ms since epoch. Ordering is the server's: ops.seq is the only order.
-- No foreign keys: gids and origins are logical references to records that live on machines.

CREATE TABLE IF NOT EXISTS brains (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  share_hash TEXT    NOT NULL UNIQUE,   -- peppered HMAC of the share id; the id itself is never stored
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  brain_id      INTEGER NOT NULL,
  machine_id    TEXT    NOT NULL,
  hostname      TEXT,
  token_hash    TEXT    NOT NULL UNIQUE,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  acked_seq     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (brain_id, machine_id)
);

-- The full op log of every brain, kept forever.
CREATE TABLE IF NOT EXISTS ops (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  brain_id     INTEGER NOT NULL,
  gid          TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  kind_family  TEXT    NOT NULL,
  origin       TEXT    NOT NULL,
  base_version INTEGER,
  payload      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  client_seq   INTEGER,
  status       TEXT    NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','conflict')),
  received_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000)
);
CREATE INDEX IF NOT EXISTS idx_ops_brain_seq ON ops(brain_id, seq);
CREATE INDEX IF NOT EXISTS idx_ops_brain_gid ON ops(brain_id, gid, kind_family, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_brain_origin_clientseq
  ON ops(brain_id, origin, client_seq) WHERE client_seq IS NOT NULL;

-- Current state: the latest accepted op per (gid, kind); a tombstone row when the record was deleted.
CREATE TABLE IF NOT EXISTS records (
  brain_id    INTEGER NOT NULL,
  gid         TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  kind_family TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  payload     TEXT    NOT NULL,
  origin      TEXT    NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  last_seq    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (brain_id, gid, kind)
);
CREATE INDEX IF NOT EXISTS idx_records_brain_gid ON records(brain_id, gid);

-- Conflict-flagged ops, kept aside until a later accepted op for the same record resolves them.
CREATE TABLE IF NOT EXISTS conflicts (
  brain_id     INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  gid          TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  kind_family  TEXT    NOT NULL,
  origin       TEXT    NOT NULL,
  base_version INTEGER,
  payload      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (brain_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_conflicts_brain_gid ON conflicts(brain_id, gid, kind_family);
