// apps/mcp/src/calendar-tools.ts
import { z } from "zod";
import {
  createEntity, updateEntity, deleteEntity, listEntities, getEntity, getEntityByName,
  linkEntities, unlinkEntities, listLinks,
  createEvent, updateEvent, deleteEvent, listEvents,
  findConflicts,
  eventsToIcs,
} from "kxta-core";
import type { CalendarEntity } from "kxta-core";

function errorResult(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Resolve an entity by name (case-insensitive) or, failing that, by numeric id. */
function resolveEntity(ref: string): CalendarEntity {
  const byName = getEntityByName(ref);
  if (byName) return byName;
  if (/^\d+$/.test(ref)) {
    const byId = getEntity(Number(ref));
    if (byId) return byId;
  }
  throw new Error(`Unknown calendar entity: ${JSON.stringify(ref)}`);
}

function withLinks(entity: CalendarEntity) {
  const links = listLinks(entity.id);
  return {
    ...entity,
    links_out: links.filter((l) => l.from_entity_id === entity.id),
    links_in: links.filter((l) => l.to_entity_id === entity.id),
  };
}

export function registerCalendarTools(server: any): void {
  server.tool(
    "calendar_add_entity",
    "SIDE-EFFECTFUL. Create a new tracked entity — any named thing you schedule events against (a server, a delivery van, a store location, a piece of equipment, a room, etc.). Not idempotent: a duplicate name (case-insensitive) throws. Returns `{entity}`. Use `calendar_link_entities` afterwards to record dependencies for conflict detection.",
    {
      name: z.string().min(1).describe("Unique display name for the entity (case-insensitive)."),
      kind: z.string().optional().describe("Freeform category, e.g. 'server', 'vehicle', 'location', 'equipment'."),
      notes: z.string().optional().describe("Freeform notes."),
      timezone: z.string().optional().describe("Optional IANA timezone (e.g. 'Europe/Berlin') for display only — does not affect stored event times."),
    },
    async (input: { name: string; kind?: string; notes?: string; timezone?: string }) => {
      try {
        return ok({ entity: createEntity(input) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_update_entity",
    "SIDE-EFFECTFUL. Patch an existing entity's fields, including `active` (set false to soft-retire it without losing its history). Idempotent per patch. Returns `{entity}`. For a hard delete see `calendar_delete_entity`.",
    {
      id: z.number().int().describe("Entity id (from `calendar_add_entity` or `calendar_list_entities`)."),
      name: z.string().min(1).optional(),
      kind: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
      active: z.boolean().optional(),
    },
    async (input: { id: number; name?: string; kind?: string | null; notes?: string | null; timezone?: string | null; active?: boolean }) => {
      try {
        const { id, ...patch } = input;
        return ok({ entity: updateEntity(id, patch) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_delete_entity",
    "DESTRUCTIVE. Permanently delete an entity AND cascade-delete every event and link attached to it. Not idempotent — deleting an unknown id throws. Returns `{success, deleted_events, deleted_links}`. To deactivate without losing history, use `calendar_update_entity` with `active: false` instead.",
    { id: z.number().int().describe("Entity id to delete.") },
    async ({ id }: { id: number }) => {
      try {
        const result = deleteEntity(id);
        return ok({ success: true, ...result });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_list_entities",
    "Read-only; no side effects, auth, or rate limits. List tracked entities, each annotated with its outgoing and incoming dependency links. Returns `{entities, count}`.",
    {
      active_only: z.boolean().optional().describe("If true, exclude retired (active=false) entities."),
      kind: z.string().optional().describe("Filter to entities with this exact `kind`."),
    },
    async (input: { active_only?: boolean; kind?: string }) => {
      const entities = listEntities(input).map(withLinks);
      return ok({ entities, count: entities.length });
    },
  );

  server.tool(
    "calendar_link_entities",
    "SIDE-EFFECTFUL. Create or update a directed dependency edge between two entities (e.g. \"A feeds B\"), or remove one with `remove: true`. Idempotent — upserts the label on repeat calls; removing an absent link is a no-op. Used by `calendar_conflicts`/`calendar_list_events` to flag overlaps across connected entities (one hop, either direction). Returns `{link}` or `{removed}`.",
    {
      from: z.string().describe("Source entity — name (case-insensitive) or numeric id."),
      to: z.string().describe("Target entity — name (case-insensitive) or numeric id."),
      label: z.string().optional().describe("Freeform label for the relationship, e.g. 'feeds', 'depends on'."),
      remove: z.boolean().optional().describe("If true, remove the link instead of creating/updating it."),
    },
    async ({ from, to, label, remove }: { from: string; to: string; label?: string; remove?: boolean }) => {
      try {
        const fromEntity = resolveEntity(from);
        const toEntity = resolveEntity(to);
        if (remove) {
          const removed = unlinkEntities(fromEntity.id, toEntity.id);
          return ok({ removed });
        }
        const link = linkEntities(fromEntity.id, toEntity.id, label ?? null);
        return ok({ link });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_add_event",
    "SIDE-EFFECTFUL. Add a one-off time window (downtime, maintenance, a delivery, a shift, an inspection, etc.) to an entity. NOT idempotent — calling this twice creates two events. `starts_at`/`ends_at` must be ISO 8601 with an explicit timezone (`Z` or `±HH:MM`) — naive timestamps are rejected because their meaning would be ambiguous once stored as UTC. Returns `{event}`. Follow up with `calendar_conflicts` to check for overlaps.",
    {
      entity: z.string().describe("Entity the event applies to — name (case-insensitive) or numeric id."),
      type: z.string().min(1).describe("Freeform event type, e.g. 'downtime', 'maintenance', 'delivery', 'shift'."),
      title: z.string().min(1).describe("Short title for the event."),
      starts_at: z.string().describe("ISO 8601 timestamp with explicit timezone, e.g. '2026-08-03T02:00:00+05:30'."),
      ends_at: z.string().describe("ISO 8601 timestamp with explicit timezone; must be after starts_at."),
      notes: z.string().optional(),
      original_timezone: z.string().optional().describe("IANA timezone the window was originally communicated in, for display."),
      source: z.string().optional().describe("Freeform provenance, e.g. 'email from ops team'."),
    },
    async (input: { entity: string; type: string; title: string; starts_at: string; ends_at: string; notes?: string; original_timezone?: string; source?: string }) => {
      try {
        const entity = resolveEntity(input.entity);
        const { entity: _entity, ...rest } = input;
        return ok({ event: createEvent({ ...rest, entity_id: entity.id }) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_update_event",
    "SIDE-EFFECTFUL. Patch an existing event (move it, retitle it, re-home it to a different entity, etc.). The merged result is re-validated — shrinking `ends_at` below `starts_at` throws. Returns `{event}`.",
    {
      id: z.number().int().describe("Event id."),
      entity: z.string().optional().describe("Move the event to a different entity — name or numeric id."),
      type: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      starts_at: z.string().optional().describe("ISO 8601 timestamp with explicit timezone."),
      ends_at: z.string().optional().describe("ISO 8601 timestamp with explicit timezone."),
      notes: z.string().nullable().optional(),
      original_timezone: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
    },
    async (input: { id: number; entity?: string; type?: string; title?: string; starts_at?: string; ends_at?: string; notes?: string | null; original_timezone?: string | null; source?: string | null }) => {
      try {
        const { id, entity, ...rest } = input;
        const entity_id = entity !== undefined ? resolveEntity(entity).id : undefined;
        return ok({ event: updateEvent(id, { ...rest, ...(entity_id !== undefined ? { entity_id } : {}) }) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_delete_event",
    "DESTRUCTIVE. Delete one event by id. Idempotent — deleting an already-absent id is a no-op. Returns `{success, existed}`.",
    { id: z.number().int().describe("Event id to delete.") },
    async ({ id }: { id: number }) => {
      const existed = deleteEvent(id);
      return ok({ success: true, existed });
    },
  );

  server.tool(
    "calendar_list_events",
    "Read-only; no side effects, auth, or rate limits. List events overlapping a window (half-open — an event ending exactly at `from` is excluded), optionally filtered by entity/type. Set `include_conflicts` to also run conflict detection over the same window and attach it. Returns `{events, count, conflicts?}`. For conflicts alone, prefer `calendar_conflicts`.",
    {
      from: z.string().optional().describe("Window start, ISO 8601 with explicit timezone."),
      to: z.string().optional().describe("Window end, ISO 8601 with explicit timezone."),
      entity: z.string().optional().describe("Filter to one entity — name or numeric id."),
      type: z.string().optional().describe("Filter to an exact event type."),
      limit: z.number().int().positive().optional().describe("Max rows (default 500)."),
      include_conflicts: z.boolean().optional().describe("If true, also compute conflicts for `from`..`to` (both required when set) and include them in the response."),
    },
    async (input: { from?: string; to?: string; entity?: string; type?: string; limit?: number; include_conflicts?: boolean }) => {
      try {
        const entity_id = input.entity !== undefined ? resolveEntity(input.entity).id : undefined;
        const events = listEvents({ from: input.from, to: input.to, entity_id, type: input.type, limit: input.limit });

        if (!input.include_conflicts) return ok({ events, count: events.length });

        if (!input.from || !input.to) {
          return errorResult(new Error("`include_conflicts` requires both `from` and `to`"));
        }
        const { conflicts, buffer_minutes } = findConflicts({
          from: input.from,
          to: input.to,
          entity_ids: entity_id !== undefined ? [entity_id] : undefined,
        });
        return ok({ events, count: events.length, conflicts, buffer_minutes });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_conflicts",
    `Read-only; no side effects, auth, or rate limits. Report scheduling conflicts in a window: overlaps on the same entity (\`overlap\`), overlaps between linked entities one hop apart (\`linked_overlap\`), and gaps smaller than a minimum buffer (\`insufficient_buffer\`). Computed on demand — nothing is persisted. Buffer defaults to the \`${"calendar.min_buffer_minutes"}\` setting (0 = off); pass \`buffer_minutes\` to override for this call. Returns \`{conflicts, count, buffer_minutes, events_considered}\`. See also \`calendar_list_events\` with \`include_conflicts\`.`,
    {
      from: z.string().describe("Window start, ISO 8601 with explicit timezone."),
      to: z.string().describe("Window end, ISO 8601 with explicit timezone."),
      entity: z.string().optional().describe("Scope to one entity (and its linked neighbors) — name or numeric id."),
      buffer_minutes: z.number().int().min(0).optional().describe("Override the configured minimum gap between events, in minutes. 0 disables buffer checks."),
    },
    async (input: { from: string; to: string; entity?: string; buffer_minutes?: number }) => {
      try {
        const entity_id = input.entity !== undefined ? resolveEntity(input.entity).id : undefined;
        const result = findConflicts({
          from: input.from,
          to: input.to,
          entity_ids: entity_id !== undefined ? [entity_id] : undefined,
          buffer_minutes: input.buffer_minutes,
        });
        return ok({ ...result, count: result.conflicts.length });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "calendar_export_ics",
    "Read-only; no side effects, auth, or rate limits. Export events in a window as an RFC 5545 ICS calendar (UTC times, no VTIMEZONE needed) for import into Outlook/Calendar apps. Returns `{ics, event_count}` with the calendar text as a JSON string field.",
    {
      from: z.string().describe("Window start, ISO 8601 with explicit timezone."),
      to: z.string().describe("Window end, ISO 8601 with explicit timezone."),
      entity: z.string().optional().describe("Filter to one entity — name or numeric id."),
      calendar_name: z.string().optional().describe("Calendar display name (X-WR-CALNAME). Defaults to 'Kontexta Calendar'."),
    },
    async (input: { from: string; to: string; entity?: string; calendar_name?: string }) => {
      try {
        const entity_id = input.entity !== undefined ? resolveEntity(input.entity).id : undefined;
        const events = listEvents({ from: input.from, to: input.to, entity_id });
        const entitiesById = new Map(listEntities().map((e) => [e.id, e]));
        const ics = eventsToIcs(events, entitiesById, { calendar_name: input.calendar_name });
        return ok({ ics, event_count: events.length });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
