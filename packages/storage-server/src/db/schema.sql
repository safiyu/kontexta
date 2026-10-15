-- schema.sql
-- Phase 4 (storage/04-server): kontexta-storage-server database schema.
--
-- The AUTHORITATIVE op-log backend for Kontexta's local-first storage sync
-- (spec 1.6-1.7). It is a standalone deployment (Dockerfile +
-- docker-compose.storage.yml) with its OWN SQLite DB under /data — NOT the
-- client's local vault DB. The two schemas are deliberately distinct:
--   * Client (packages/core): outbox + sync_cursor + clients  (migrations 013/014)
--   * Server (this file):     ops (global seq-ordered op log) + clients
--
-- Conventions (mirror core migrations 013/014):
--   * Applied whole at startup via db.exec(); all DDL is idempotent (IF NOT
--     EXISTS) so a re-run never errors.
--   * Time columns are INTEGER ms since epoch (matches Op.created_at and the
--     local outbox) so they compare directly against JS Date.now().
--   * ops.payload is the canonical JSON of op.payload (null payload -> the 4
--     chars "null"), exactly as the local outbox stores it, so an op round-
--     trips through parseOp/deserializeOp unchanged.
--   * No foreign keys: ops.gid / ops.origin are logical refs to records that
--     live on client machines, not local row constraints.
--   * Ordering is the SERVER's authority (spec 1.7): ops.seq is a single
--     AUTOINCREMENT column and the sole source of ordering. Client clocks
--     (ops.created_at) are untrusted and never used to order.

-- 1. The authoritative op log. Every op a client POSTs is appended and
--    assigned the next global seq. GET /ops?since=<cursor> serves rows with
--    seq > <cursor> in seq order (the sync-loop hot path); the PK serves that
--    ordering. The six Op schema fields (spec 1.3) are their own columns so
--    the server can filter / order / look up per-gid without decoding payloads.
CREATE TABLE IF NOT EXISTS ops (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT, -- authoritative global order (server-assigned)
  gid          TEXT    NOT NULL,                  -- <localId>@<machineId>
  kind         TEXT    NOT NULL,                  -- one of OP_KINDS (validated by the codec, not here)
  origin       TEXT    NOT NULL,                  -- originating machine_id (16-hex)
  base_version INTEGER,                           -- optimistic concurrency; NULL for create ops
  payload      TEXT    NOT NULL,                  -- canonical JSON of op.payload
  created_at   INTEGER NOT NULL,                  -- client wall-clock ms (informative; never for ordering)
  client_seq   INTEGER,                           -- client local outbox id; NULL legal for callers without one
  status       TEXT    NOT NULL DEFAULT 'accepted'
             CHECK (status IN ('accepted','conflict')),  -- conflict set when base_version < current version (1.7)
  received_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000)
);

-- Per-gid lookups: conflict detection + per-record history (current version /
-- last seq for a gid). seq is the secondary key so history is seq-ordered.
CREATE INDEX IF NOT EXISTS idx_ops_gid ON ops(gid, seq);

-- Idempotent retry dedup: a given origin machine's given local outbox id is
-- stored at most once, so a retried POST /ops batch never double-stores.
-- Partial, so NULL client_seq (optional / legacy) is free.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_origin_clientseq
  ON ops(origin, client_seq) WHERE client_seq IS NOT NULL;

-- 2. The machines this server knows. One row per machine, keyed on the stable
--    16-hex machine_id (the same identity the client stores in
--    settings.machine_id). token_hash is the scrypt hash of the client's sync
--    token (see auth.ts); the plaintext token is returned ONCE at
--    registration and never stored. Time columns are ms-since-epoch.
CREATE TABLE IF NOT EXISTS clients (
  machine_id   TEXT PRIMARY KEY,
  hostname     TEXT,
  token_hash   TEXT    NOT NULL,                  -- scrypt hash of the sync token; indexed for O(1) auth
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_token_hash ON clients(token_hash);
CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen_at DESC);
