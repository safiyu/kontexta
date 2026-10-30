-- 017-lost-push.sql
-- Marks a gid whose own push lost to another machine's edit, so the next accepted remote content op forks instead of overwriting.
ALTER TABLE gid_versions ADD COLUMN lost_push INTEGER NOT NULL DEFAULT 0;
