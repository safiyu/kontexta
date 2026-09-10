-- Re-backfill content_class with Windows-safe LIKE patterns; 008 forward-slash LIKE never matched on Windows so every KB row stayed NULL. Idempotent.
UPDATE files SET content_class = 'project'
  WHERE storage_type IN ('reference', 'backup')
    AND (content_class IS NULL OR content_class != 'project');

UPDATE files SET content_class = 'dictionary'
  WHERE storage_type = 'local'
    AND (REPLACE(path, '\', '/') LIKE '%/knowledge/knowledge/dictionary/%'
         OR REPLACE(path, '\', '/') LIKE '%/knowledge/knowledge/urlclips/%')
    AND (content_class IS NULL OR content_class != 'dictionary');

UPDATE files SET content_class = 'note'
  WHERE storage_type = 'local'
    AND REPLACE(path, '\', '/') LIKE '%/knowledge/knowledge/notes/%'
    AND (content_class IS NULL OR content_class != 'note');

UPDATE files SET content_class = 'journal'
  WHERE storage_type = 'local'
    AND REPLACE(path, '\', '/') LIKE '%/knowledge/journal/%'
    AND (content_class IS NULL OR content_class != 'journal');

-- New in 009: rendered artifacts (mermaid diagrams, html reports) → note.
UPDATE files SET content_class = 'note'
  WHERE storage_type = 'local'
    AND (REPLACE(path, '\', '/') LIKE '%/knowledge/mermaid/%'
         OR REPLACE(path, '\', '/') LIKE '%/knowledge/html/%')
    AND (content_class IS NULL OR content_class != 'note');
