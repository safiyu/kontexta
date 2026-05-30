-- Journaling & indexing — Phase 1 tables.
-- See docs/superpowers/specs/2026-05-12-journaling-and-indexing-design.md §4.5

CREATE TABLE IF NOT EXISTS journal_meta (
  file_id        INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  task_slug      TEXT NOT NULL,
  status_latest  TEXT,
  started_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  touched_files  TEXT NOT NULL DEFAULT '[]',
  raw_sources    TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_journal_project_active
  ON journal_meta(project_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_project_status
  ON journal_meta(project_id, status_latest);
CREATE INDEX IF NOT EXISTS idx_journal_task_slug
  ON journal_meta(project_id, task_slug);

CREATE TABLE IF NOT EXISTS journal_touches (
  file_id      INTEGER NOT NULL REFERENCES journal_meta(file_id) ON DELETE CASCADE,
  touched_path TEXT NOT NULL,
  PRIMARY KEY (file_id, touched_path)
);
CREATE INDEX IF NOT EXISTS idx_journal_touches_path ON journal_touches(touched_path);

CREATE TABLE IF NOT EXISTS journal_git_refs (
  file_id   INTEGER NOT NULL REFERENCES journal_meta(file_id) ON DELETE CASCADE,
  ref_type  TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  PRIMARY KEY (file_id, ref_type, ref_value)
);
CREATE INDEX IF NOT EXISTS idx_journal_git_value ON journal_git_refs(ref_type, ref_value);

-- Per-project high-water mark for distillation. Single row per project_slug.
-- Stored in DB (not just on disk) so SQL queries can report status without filesystem walk.
CREATE TABLE IF NOT EXISTS journal_high_water (
  project_slug      TEXT PRIMARY KEY,
  last_event_ts     TEXT NOT NULL,
  last_distilled_at TEXT NOT NULL,
  events_processed  INTEGER NOT NULL DEFAULT 0
);
