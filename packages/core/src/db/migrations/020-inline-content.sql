-- 020-inline-content.sql
-- Store file bodies directly in SQLite for local storage,
-- add compressed file revisions history table, and virtual folders.

-- 1. Add content column to files (if not exists)
ALTER TABLE files ADD COLUMN content TEXT;

-- 2. File revisions table for snapshot history
CREATE TABLE IF NOT EXISTS file_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  rev_hash TEXT NOT NULL,
  content_compressed BLOB NOT NULL,
  message TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'Kontexta',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_revisions_file_id
  ON file_revisions(file_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_file_revisions_hash
  ON file_revisions(file_id, rev_hash);

-- 3. Virtual folders table
CREATE TABLE IF NOT EXISTS virtual_folders (
  path TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

