-- 015-endpoint-config.sql
-- Phase 4 (storage/04-server): sync-endpoint configuration in local settings.
--
-- Goals:
--   Persist the machine's connection to the authoritative storage server
--   (packages/storage-server, spec 1.6-1.7) in the local `settings` table so
--   the sync loop (kxta-core storage/client.ts) and the `kontexta endpoint`
--   CLI (connect / status / disconnect / push / pull) can read and update it
--   across process restarts — apps/mcp and apps/web both poll the same vault.
--
--   The four keys:
--     endpoint_url            the server base URL (e.g. https://store.example.com).
--                             Empty = NOT connected: the sync loop stays
--                             disabled, and a machine that has never run
--                             `kontexta endpoint connect` simply does not sync.
--     endpoint_token          the machine's one-time sync token, minted by the
--                             server's POST /clients and returned exactly once.
--                             This is the machine's credential to the server —
--                             it lives in the local vault data directory, never
--                             on the wire unauthenticated (the server only ever
--                             stores its peppered hash).
--     poll_active_interval_ms the short-poll cadence while the machine is
--                             active (user/agent activity): 15000 ms (15 s),
--                             spec 1.6.
--     poll_idle_interval_ms   the short-poll cadence while idle: 60000 ms
--                             (60 s), spec 1.6. (Failure backoff — exponential,
--                             up to 5 min — is runtime state in the sync loop,
--                             not a persisted setting.)
--
-- Conventions (see runner in src/db/index.ts + migrations 005 / 013 / 014):
--   * The runner wraps this file in a transaction; no BEGIN/COMMIT here.
--   * `settings` (005) is the existing key/value store; no new table is
--     warranted for four scalar values. `updated_at` is a TEXT timestamp
--     (datetime('now')), matching every other settings row.
--   * `INSERT OR IGNORE` seeds the defaults ONCE: a later `setSetting`
--     (upsert) or `deleteSetting` (disconnect) owns the value from then on,
--     and a re-run of this migration never clobbers a user's configured
--     endpoint. Idempotent by construction.

INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES ('endpoint_url', '', datetime('now'));

INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES ('endpoint_token', '', datetime('now'));

-- Spec 1.6: 15 s active poll, 60 s idle poll. The sync loop rewrites these if
-- a deployment wants a different cadence (the values are read on every loop
-- tick, not baked in).
INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES ('poll_active_interval_ms', '15000', datetime('now'));

INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES ('poll_idle_interval_ms', '60000', datetime('now'));
