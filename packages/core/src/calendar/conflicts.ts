import { getSetting } from "../metadata/settings.js";
import { listEvents, listLinks, listEntities } from "./repository.js";
import type { CalendarEntity, CalendarEvent, CalendarLink, Conflict } from "./types.js";

export const BUFFER_SETTING_KEY = "calendar.min_buffer_minutes";

/** Read the configured default buffer (minutes). 0 (or unset/invalid) disables buffer checks. */
export function getBufferMinutes(): number {
  const raw = getSetting(BUFFER_SETTING_KEY);
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
}

function linkKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function buildAdjacency(links: CalendarLink[]): Map<string, CalendarLink> {
  const map = new Map<string, CalendarLink>();
  for (const link of links) {
    const key = linkKey(link.from_entity_id, link.to_entity_id);
    if (!map.has(key)) map.set(key, link);
  }
  return map;
}

function entityRef(entity: CalendarEntity | undefined, id: number) {
  return { id, name: entity?.name ?? `#${id}` };
}

export interface DetectConflictsInput {
  events: CalendarEvent[];
  links: CalendarLink[];
  entities: CalendarEntity[];
  buffer_minutes: number;
}

/**
 * Pure conflict detector: no DB access. Flags same-entity overlaps, overlaps
 * between events on linked entities (one hop only, direction-agnostic), and
 * gaps smaller than buffer_minutes (same or linked entities). Overlap takes
 * precedence over the buffer check for a given pair — at most one conflict
 * per pair is reported.
 */
export function detectConflicts(input: DetectConflictsInput): Conflict[] {
  const { links, entities, buffer_minutes } = input;
  const adjacency = buildAdjacency(links);
  const entitiesById = new Map(entities.map((e) => [e.id, e]));

  const events = [...input.events].sort((a, b) => {
    if (a.starts_at !== b.starts_at) return a.starts_at < b.starts_at ? -1 : 1;
    return a.id - b.id;
  });

  const conflicts: Conflict[] = [];

  for (let i = 0; i < events.length; i++) {
    const a = events[i];
    const aEndMs = Date.parse(a.ends_at);
    const boundary = new Date(aEndMs + buffer_minutes * 60_000).toISOString();

    for (let j = i + 1; j < events.length; j++) {
      const b = events[j];
      if (b.starts_at >= boundary) break;

      const sameEntity = a.entity_id === b.entity_id;
      const key = linkKey(a.entity_id, b.entity_id);
      const link = sameEntity ? null : adjacency.get(key) ?? null;
      if (!sameEntity && !link) continue;

      const overlaps = a.starts_at < b.ends_at && b.starts_at < a.ends_at;

      const entity_a = entityRef(entitiesById.get(a.entity_id), a.entity_id);
      const entity_b = entityRef(entitiesById.get(b.entity_id), b.entity_id);

      if (overlaps) {
        const kind = sameEntity ? "overlap" : "linked_overlap";
        const reason = sameEntity
          ? `"${a.title}" overlaps "${b.title}" on ${entity_a.name}`
          : `"${a.title}" on ${entity_a.name} overlaps "${b.title}" on ${entity_b.name}` +
            (link?.label ? ` (linked: ${entity_a.name} -> ${entity_b.name} "${link.label}")` : ` (linked entities)`);
        conflicts.push({
          kind,
          event_a: a,
          event_b: b,
          entity_a,
          entity_b,
          link,
          gap_minutes: null,
          reason,
        });
        continue;
      }

      if (buffer_minutes > 0) {
        const gapMinutes = (Date.parse(b.starts_at) - aEndMs) / 60_000;
        if (gapMinutes < buffer_minutes) {
          const reason = sameEntity
            ? `"${a.title}" and "${b.title}" on ${entity_a.name} leave only ${gapMinutes} minute(s) of buffer (minimum ${buffer_minutes})`
            : `"${a.title}" on ${entity_a.name} and "${b.title}" on ${entity_b.name} leave only ${gapMinutes} minute(s) of buffer (minimum ${buffer_minutes})`;
          conflicts.push({
            kind: "insufficient_buffer",
            event_a: a,
            event_b: b,
            entity_a,
            entity_b,
            link,
            gap_minutes: gapMinutes,
            reason,
          });
        }
      }
    }
  }

  return conflicts;
}

export interface FindConflictsOptions {
  from: string;
  to: string;
  entity_ids?: number[];
  buffer_minutes?: number;
}

export interface FindConflictsResult {
  conflicts: Conflict[];
  buffer_minutes: number;
  events_considered: number;
}

/** Convenience wrapper: load events/links/entities for a window and detect conflicts. */
export function findConflicts(opts: FindConflictsOptions): FindConflictsResult {
  const buffer_minutes = opts.buffer_minutes ?? getBufferMinutes();
  const links = listLinks();
  const entities = listEntities();
  const allEvents = listEvents({ from: opts.from, to: opts.to });

  const scoped = opts.entity_ids && opts.entity_ids.length > 0 ? new Set(opts.entity_ids) : null;

  let events = allEvents;
  if (scoped) {
    // Include 1-hop neighbors so linked_overlap/insufficient_buffer against a
    // scoped entity is still detectable, even though the neighbor itself is
    // out of scope.
    const candidateIds = new Set(scoped);
    for (const link of links) {
      if (scoped.has(link.from_entity_id)) candidateIds.add(link.to_entity_id);
      if (scoped.has(link.to_entity_id)) candidateIds.add(link.from_entity_id);
    }
    events = allEvents.filter((e) => candidateIds.has(e.entity_id));
  }

  let conflicts = detectConflicts({ events, links, entities, buffer_minutes });
  if (scoped) {
    conflicts = conflicts.filter((c) => scoped.has(c.entity_a.id) || scoped.has(c.entity_b.id));
  }

  return { conflicts, buffer_minutes, events_considered: events.length };
}
