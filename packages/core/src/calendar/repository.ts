import { getDatabase } from "../db/index.js";
import type { CalendarEntity, CalendarLink, CalendarEvent } from "./types.js";
import { parseInstant, assertValidTimezone, assertRange } from "./validate.js";

interface RawEntityRow {
  id: number;
  name: string;
  kind: string | null;
  notes: string | null;
  timezone: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

function mapEntity(row: RawEntityRow): CalendarEntity {
  return { ...row, active: row.active !== 0 };
}

function requireEntity(id: number): RawEntityRow {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM calendar_entities WHERE id = ?`).get(id) as
    | RawEntityRow
    | undefined;
  if (!row) throw new Error(`Unknown calendar entity id: ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface CreateEntityInput {
  name: string;
  kind?: string | null;
  notes?: string | null;
  timezone?: string | null;
  active?: boolean;
}

export function createEntity(input: CreateEntityInput, now: Date = new Date()): CalendarEntity {
  const name = input.name.trim();
  if (!name) throw new RangeError("`name` is required");
  if (input.timezone) assertValidTimezone(input.timezone);

  const db = getDatabase();
  const existing = db
    .prepare(`SELECT id FROM calendar_entities WHERE name = ? COLLATE NOCASE`)
    .get(name) as { id: number } | undefined;
  if (existing) throw new Error(`A calendar entity named ${JSON.stringify(name)} already exists`);

  const ts = now.toISOString();
  const result = db
    .prepare(
      `INSERT INTO calendar_entities (name, kind, notes, timezone, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, input.kind ?? null, input.notes ?? null, input.timezone ?? null, input.active === false ? 0 : 1, ts, ts);

  return mapEntity(requireEntity(Number(result.lastInsertRowid)));
}

export interface UpdateEntityPatch {
  name?: string;
  kind?: string | null;
  notes?: string | null;
  timezone?: string | null;
  active?: boolean;
}

export function updateEntity(
  id: number,
  patch: UpdateEntityPatch,
  now: Date = new Date(),
): CalendarEntity {
  const db = getDatabase();
  const current = requireEntity(id);

  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) throw new RangeError("`name` cannot be empty");
  if (patch.name !== undefined) {
    const collision = db
      .prepare(`SELECT id FROM calendar_entities WHERE name = ? COLLATE NOCASE AND id <> ?`)
      .get(name, id) as { id: number } | undefined;
    if (collision) throw new Error(`A calendar entity named ${JSON.stringify(name)} already exists`);
  }

  const timezone = patch.timezone !== undefined ? patch.timezone : current.timezone;
  if (timezone) assertValidTimezone(timezone);

  const kind = patch.kind !== undefined ? patch.kind : current.kind;
  const notes = patch.notes !== undefined ? patch.notes : current.notes;
  const active = patch.active !== undefined ? (patch.active ? 1 : 0) : current.active;
  const updated_at = now.toISOString();

  db.prepare(
    `UPDATE calendar_entities SET name = ?, kind = ?, notes = ?, timezone = ?, active = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, kind, notes, timezone, active, updated_at, id);

  return mapEntity(requireEntity(id));
}

export interface DeleteEntityResult {
  deleted_events: number;
  deleted_links: number;
}

export function deleteEntity(id: number): DeleteEntityResult {
  const db = getDatabase();
  requireEntity(id);

  return db.transaction((): DeleteEntityResult => {
    const events = db
      .prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE entity_id = ?`)
      .get(id) as { n: number };
    const links = db
      .prepare(
        `SELECT COUNT(*) AS n FROM calendar_links WHERE from_entity_id = ? OR to_entity_id = ?`,
      )
      .get(id, id) as { n: number };

    db.prepare(`DELETE FROM calendar_entities WHERE id = ?`).run(id);

    return { deleted_events: events.n, deleted_links: links.n };
  })();
}

export function getEntity(id: number): CalendarEntity | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM calendar_entities WHERE id = ?`).get(id) as
    | RawEntityRow
    | undefined;
  return row ? mapEntity(row) : null;
}

export function getEntityByName(name: string): CalendarEntity | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM calendar_entities WHERE name = ? COLLATE NOCASE`)
    .get(name) as RawEntityRow | undefined;
  return row ? mapEntity(row) : null;
}

export interface ListEntitiesFilter {
  active_only?: boolean;
  kind?: string;
}

export function listEntities(filter: ListEntitiesFilter = {}): CalendarEntity[] {
  const db = getDatabase();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.active_only) clauses.push("active = 1");
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM calendar_entities ${where} ORDER BY name COLLATE NOCASE`)
    .all(...params) as RawEntityRow[];
  return rows.map(mapEntity);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function linkEntities(
  from_entity_id: number,
  to_entity_id: number,
  label: string | null = null,
  now: Date = new Date(),
): CalendarLink {
  if (from_entity_id === to_entity_id) throw new RangeError("An entity cannot be linked to itself");
  requireEntity(from_entity_id);
  requireEntity(to_entity_id);

  const db = getDatabase();
  const ts = now.toISOString();
  db.prepare(
    `INSERT INTO calendar_links (from_entity_id, to_entity_id, label, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(from_entity_id, to_entity_id) DO UPDATE SET label = excluded.label`,
  ).run(from_entity_id, to_entity_id, label, ts);

  const row = db
    .prepare(`SELECT * FROM calendar_links WHERE from_entity_id = ? AND to_entity_id = ?`)
    .get(from_entity_id, to_entity_id) as CalendarLink;
  return row;
}

export function unlinkEntities(from_entity_id: number, to_entity_id: number): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`DELETE FROM calendar_links WHERE from_entity_id = ? AND to_entity_id = ?`)
    .run(from_entity_id, to_entity_id);
  return result.changes > 0;
}

export function listLinks(entity_id?: number): CalendarLink[] {
  const db = getDatabase();
  if (entity_id === undefined) {
    return db.prepare(`SELECT * FROM calendar_links ORDER BY id`).all() as CalendarLink[];
  }
  return db
    .prepare(
      `SELECT * FROM calendar_links WHERE from_entity_id = ? OR to_entity_id = ? ORDER BY id`,
    )
    .all(entity_id, entity_id) as CalendarLink[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  entity_id: number;
  type: string;
  title: string;
  notes?: string | null;
  starts_at: string;
  ends_at: string;
  original_timezone?: string | null;
  source?: string | null;
}

export function createEvent(input: CreateEventInput, now: Date = new Date()): CalendarEvent {
  requireEntity(input.entity_id);

  const type = input.type.trim();
  if (!type) throw new RangeError("`type` is required");
  const title = input.title.trim();
  if (!title) throw new RangeError("`title` is required");

  const starts_at = parseInstant(input.starts_at, "starts_at");
  const ends_at = parseInstant(input.ends_at, "ends_at");
  assertRange(starts_at, ends_at);
  if (input.original_timezone) assertValidTimezone(input.original_timezone);

  const db = getDatabase();
  const ts = now.toISOString();
  const result = db
    .prepare(
      `INSERT INTO calendar_events
         (entity_id, type, title, notes, starts_at, ends_at, original_timezone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.entity_id,
      type,
      title,
      input.notes ?? null,
      starts_at,
      ends_at,
      input.original_timezone ?? null,
      input.source ?? null,
      ts,
      ts,
    );

  return getEvent(Number(result.lastInsertRowid))!;
}

export interface UpdateEventPatch {
  entity_id?: number;
  type?: string;
  title?: string;
  notes?: string | null;
  starts_at?: string;
  ends_at?: string;
  original_timezone?: string | null;
  source?: string | null;
}

export function updateEvent(
  id: number,
  patch: UpdateEventPatch,
  now: Date = new Date(),
): CalendarEvent {
  const db = getDatabase();
  const current = getEvent(id);
  if (!current) throw new Error(`Unknown calendar event id: ${id}`);

  const entity_id = patch.entity_id !== undefined ? patch.entity_id : current.entity_id;
  if (patch.entity_id !== undefined) requireEntity(entity_id);

  const type = patch.type !== undefined ? patch.type.trim() : current.type;
  if (!type) throw new RangeError("`type` cannot be empty");
  const title = patch.title !== undefined ? patch.title.trim() : current.title;
  if (!title) throw new RangeError("`title` cannot be empty");

  const starts_at = patch.starts_at !== undefined ? parseInstant(patch.starts_at, "starts_at") : current.starts_at;
  const ends_at = patch.ends_at !== undefined ? parseInstant(patch.ends_at, "ends_at") : current.ends_at;
  assertRange(starts_at, ends_at);

  const original_timezone =
    patch.original_timezone !== undefined ? patch.original_timezone : current.original_timezone;
  if (original_timezone) assertValidTimezone(original_timezone);
  const notes = patch.notes !== undefined ? patch.notes : current.notes;
  const source = patch.source !== undefined ? patch.source : current.source;
  const updated_at = now.toISOString();

  db.prepare(
    `UPDATE calendar_events SET
       entity_id = ?, type = ?, title = ?, notes = ?, starts_at = ?, ends_at = ?,
       original_timezone = ?, source = ?, updated_at = ?
     WHERE id = ?`,
  ).run(entity_id, type, title, notes, starts_at, ends_at, original_timezone, source, updated_at, id);

  return getEvent(id)!;
}

export function deleteEvent(id: number): boolean {
  const db = getDatabase();
  const result = db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getEvent(id: number): CalendarEvent | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as
    | CalendarEvent
    | undefined;
  return row ?? null;
}

export interface ListEventsFilter {
  from?: string;
  to?: string;
  entity_id?: number;
  type?: string;
  limit?: number;
}

export function listEvents(filter: ListEventsFilter = {}): CalendarEvent[] {
  const db = getDatabase();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.to !== undefined) {
    clauses.push("starts_at < ?");
    params.push(parseInstant(filter.to, "to"));
  }
  if (filter.from !== undefined) {
    clauses.push("ends_at > ?");
    params.push(parseInstant(filter.from, "from"));
  }
  if (filter.entity_id !== undefined) {
    clauses.push("entity_id = ?");
    params.push(filter.entity_id);
  }
  if (filter.type) {
    clauses.push("type = ?");
    params.push(filter.type);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filter.limit && filter.limit > 0 ? filter.limit : 500;

  return db
    .prepare(`SELECT * FROM calendar_events ${where} ORDER BY starts_at, id LIMIT ?`)
    .all(...params, limit) as CalendarEvent[];
}
