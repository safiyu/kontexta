-- Speeds up dedup lookup for clipped URLs (clipUrl looks up files by source_path).
CREATE INDEX IF NOT EXISTS idx_files_source_path ON files(source_path);
