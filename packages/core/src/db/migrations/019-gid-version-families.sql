-- 019-gid-version-families.sql
-- The relay versions each record per kind family (content vs metadata), so the machine tracks versions the same way.
CREATE TABLE gid_versions_v2 (
  gid       TEXT    NOT NULL,
  family    TEXT    NOT NULL,
  version   INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lost_push INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (gid, family)
);
INSERT INTO gid_versions_v2 (gid, family, version, lost_push) SELECT gid, 'content', version, lost_push FROM gid_versions;
DROP TABLE gid_versions;
ALTER TABLE gid_versions_v2 RENAME TO gid_versions;
