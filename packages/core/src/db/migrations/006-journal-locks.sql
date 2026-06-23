-- 006-journal-locks.sql
-- Cross-process advisory locks. Replaces the per-process file-based
-- distill cooldown lock with a DB row that's atomic across processes via
-- SQLite's WAL/transaction guarantees.

CREATE TABLE IF NOT EXISTS journal_locks (
  lock_key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL  -- ms since epoch
);
