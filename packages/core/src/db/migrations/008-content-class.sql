-- Content-class column: authority axis, independent of storage_type.
-- 'dictionary' here is NOT the same as storage_type='reference' — different axes.
-- See docs/superpowers/specs/2026-09-10-content-class-reference-vs-notes-design.md
ALTER TABLE files ADD COLUMN content_class TEXT
  CHECK (content_class IN ('dictionary', 'note', 'journal', 'project') OR content_class IS NULL);

CREATE INDEX IF NOT EXISTS idx_files_content_class ON files(content_class);

-- Backfill rule 1: non-local storage → 'project'.
UPDATE files SET content_class = 'project'
  WHERE storage_type IN ('reference', 'backup');

-- Backfill rule 2: local KB files by path suffix. The disk layout for the
-- three named KB subfolders is <dataDir>/knowledge/knowledge/{dictionary,notes,urlclips}
-- and <dataDir>/knowledge/journal for the journal bucket. LIKE with '%'
-- anchors on those suffixes regardless of dataDir prefix.
UPDATE files SET content_class = 'dictionary'
  WHERE storage_type = 'local'
    AND (path LIKE '%/knowledge/knowledge/dictionary/%'
         OR path LIKE '%/knowledge/knowledge/urlclips/%');

UPDATE files SET content_class = 'note'
  WHERE storage_type = 'local'
    AND path LIKE '%/knowledge/knowledge/notes/%';

UPDATE files SET content_class = 'journal'
  WHERE storage_type = 'local'
    AND path LIKE '%/knowledge/journal/%';
-- Everything else (local KB outside named subfolders) stays NULL by design.
