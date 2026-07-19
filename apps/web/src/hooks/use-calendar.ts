"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { CalendarEntity, CalendarLink, CalendarEvent, Conflict } from "kxta-core";

export interface UseEntitiesReturn {
  entities: CalendarEntity[];
  links: CalendarLink[];
  loading: boolean;
  refresh: () => void;
}

export function useEntities(): UseEntitiesReturn {
  const [entities, setEntities] = useState<CalendarEntity[]>([]);
  const [links, setLinks] = useState<CalendarLink[]>([]);
  const [loading, setLoading] = useState(true);

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = useCallback(async () => {
    const mySeq = ++seqRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      setLoading(true);
      const [entitiesRes, linksRes] = await Promise.all([
        fetch("/api/calendar/entities", { signal: ac.signal }),
        fetch("/api/calendar/links", { signal: ac.signal }),
      ]);

      if (mySeq !== seqRef.current) return;

      if (entitiesRes.ok) setEntities(await entitiesRes.json());
      if (linksRes.ok) setLinks(await linksRes.json());
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      console.error("Failed to fetch calendar entities:", error);
    } finally {
      if (mySeq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    return () => abortRef.current?.abort();
  }, [fetchAll]);

  return { entities, links, loading, refresh: fetchAll };
}

export interface UseCalendarDataOptions {
  fromIso: string;
  toIso: string;
  entityId?: number;
  type?: string;
}

export interface UseCalendarDataReturn {
  events: CalendarEvent[];
  conflicts: Conflict[];
  bufferMinutes: number;
  eventsConsidered: number;
  loading: boolean;
  refresh: () => void;
}

export function useCalendarData(options: UseCalendarDataOptions): UseCalendarDataReturn {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [bufferMinutes, setBufferMinutes] = useState(0);
  const [eventsConsidered, setEventsConsidered] = useState(0);
  const [loading, setLoading] = useState(true);

  const optsRef = useRef(options);
  optsRef.current = options;

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = useCallback(async () => {
    const o = optsRef.current;
    const mySeq = ++seqRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      setLoading(true);

      const eventsParams = new URLSearchParams({ from: o.fromIso, to: o.toIso });
      if (o.entityId !== undefined) eventsParams.append("entity_id", String(o.entityId));
      if (o.type) eventsParams.append("type", o.type);

      const conflictsParams = new URLSearchParams({ from: o.fromIso, to: o.toIso });
      if (o.entityId !== undefined) conflictsParams.append("entity_ids", String(o.entityId));

      const [eventsRes, conflictsRes] = await Promise.all([
        fetch(`/api/calendar/events?${eventsParams.toString()}`, { signal: ac.signal }),
        fetch(`/api/calendar/conflicts?${conflictsParams.toString()}`, { signal: ac.signal }),
      ]);

      if (mySeq !== seqRef.current) return;

      if (eventsRes.ok) setEvents(await eventsRes.json());
      if (conflictsRes.ok) {
        const data = await conflictsRes.json();
        setConflicts(data.conflicts);
        setBufferMinutes(data.buffer_minutes);
        setEventsConsidered(data.events_considered);
      }
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      console.error("Failed to fetch calendar data:", error);
    } finally {
      if (mySeq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    return () => abortRef.current?.abort();
  }, [options.fromIso, options.toIso, options.entityId, options.type, fetchAll]);

  return { events, conflicts, bufferMinutes, eventsConsidered, loading, refresh: fetchAll };
}
