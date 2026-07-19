export interface CalendarEntity {
  id: number;
  name: string;
  kind: string | null;
  notes: string | null;
  timezone: string | null; // IANA tz, display only
  active: boolean;
  created_at: string; // ISO 8601 UTC
  updated_at: string; // ISO 8601 UTC
}

export interface CalendarLink {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  label: string | null;
  created_at: string; // ISO 8601 UTC
}

export interface CalendarEvent {
  id: number;
  entity_id: number;
  type: string;
  title: string;
  notes: string | null;
  starts_at: string; // ISO 8601 UTC
  ends_at: string; // ISO 8601 UTC, exclusive
  original_timezone: string | null;
  source: string | null;
  created_at: string; // ISO 8601 UTC
  updated_at: string; // ISO 8601 UTC
}

export type ConflictKind = "overlap" | "linked_overlap" | "insufficient_buffer";

export interface ConflictEntityRef {
  id: number;
  name: string;
}

export interface ConflictLinkRef {
  id: number;
  label: string | null;
  from_entity_id: number;
  to_entity_id: number;
}

export interface Conflict {
  kind: ConflictKind;
  event_a: CalendarEvent; // earlier starts_at
  event_b: CalendarEvent;
  entity_a: ConflictEntityRef;
  entity_b: ConflictEntityRef;
  link: ConflictLinkRef | null; // set for linked_overlap and cross-entity buffer conflicts
  gap_minutes: number | null; // set for insufficient_buffer
  reason: string; // human-readable, generic wording only
}
