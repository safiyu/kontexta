-- 007-calendar.sql
-- Generic dependency-aware maintenance/downtime calendar.
-- Entities are any named thing you schedule against (servers, vehicles,
-- locations, equipment, rooms, etc.); links are directed dependency edges
-- between them; events are one-off time windows on an entity. Conflict
-- detection is computed on demand in application code — nothing about
-- conflicts is persisted here.

CREATE TABLE IF NOT EXISTS calendar_entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE,
  kind       TEXT,                -- freeform: 'server' | 'vehicle' | 'location' | ...
  notes      TEXT,
  timezone   TEXT,                -- optional IANA tz, display only
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,       -- ISO 8601 UTC
  updated_at TEXT NOT NULL        -- ISO 8601 UTC
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_entities_name
  ON calendar_entities(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS calendar_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id INTEGER NOT NULL REFERENCES calendar_entities(id) ON DELETE CASCADE,
  to_entity_id   INTEGER NOT NULL REFERENCES calendar_entities(id) ON DELETE CASCADE,
  label          TEXT,            -- freeform: 'feeds', 'depends on', ...
  created_at     TEXT NOT NULL,   -- ISO 8601 UTC
  UNIQUE (from_entity_id, to_entity_id),
  CHECK (from_entity_id <> to_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_links_to ON calendar_links(to_entity_id);

CREATE TABLE IF NOT EXISTS calendar_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id         INTEGER NOT NULL REFERENCES calendar_entities(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,       -- freeform: 'downtime' | 'maintenance' | 'delivery' | ...
  title             TEXT NOT NULL,
  notes             TEXT,
  starts_at         TEXT NOT NULL,       -- ISO 8601 UTC
  ends_at           TEXT NOT NULL,       -- ISO 8601 UTC, exclusive; > starts_at
  original_timezone TEXT,                -- tz string the time was communicated in, display only
  source            TEXT,                -- freeform provenance
  created_at        TEXT NOT NULL,       -- ISO 8601 UTC
  updated_at        TEXT NOT NULL,       -- ISO 8601 UTC
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_entity_start ON calendar_events(entity_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_end   ON calendar_events(ends_at);
