-- 018-brain.sql
-- Brains: the machine-side connection moves from endpoint_* to remote_* / brain_* settings, plus a core-owned machine secret.
DELETE FROM settings WHERE key IN ('endpoint_url', 'endpoint_token');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('machine_secret', lower(hex(randomblob(32))), datetime('now'));
