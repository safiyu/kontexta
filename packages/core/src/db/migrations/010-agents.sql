-- Per-agent enablement and hook install/verification state.
-- See docs/superpowers/specs/2026-09-29-agent-hooks-design.md §3.1

CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT PRIMARY KEY,
  enabled             INTEGER NOT NULL DEFAULT 0,
  hooks_supported     INTEGER NOT NULL DEFAULT 0,
  hooks_installed     INTEGER NOT NULL DEFAULT 0,
  hooks_version       TEXT,
  hooks_installed_at  TEXT,
  hooks_verified_at   TEXT,
  last_hook_event_at  TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
