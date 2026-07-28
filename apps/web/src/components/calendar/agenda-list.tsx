"use client";

import { useMemo } from "react";
import type { CalendarEntity, CalendarEvent, Conflict } from "kxta-core";
import { fmtTime, isSameDay, startOfDay } from "./date-utils";
import { colorForType } from "./event-colors";

interface AgendaListProps {
  events: CalendarEvent[];
  entitiesById: Map<number, CalendarEntity>;
  conflicts: Conflict[];
  loading: boolean;
  highlightIds: Set<number>;
  onEventClick: (ev: CalendarEvent) => void;
}

function dayKey(d: Date): string {
  return startOfDay(d).toISOString();
}

function fmtDayHeader(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export function AgendaList({ events, entitiesById, conflicts, loading, highlightIds, onEventClick }: AgendaListProps) {
  const conflictsByEventId = useMemo(() => {
    const map = new Map<number, Conflict[]>();
    for (const c of conflicts) {
      if (!map.has(c.event_a.id)) map.set(c.event_a.id, []);
      map.get(c.event_a.id)!.push(c);
      if (!map.has(c.event_b.id)) map.set(c.event_b.id, []);
      map.get(c.event_b.id)!.push(c);
    }
    return map;
  }, [conflicts]);

  const groups = useMemo(() => {
    const sorted = [...events].sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
    const byDay = new Map<string, { day: Date; items: CalendarEvent[] }>();
    for (const ev of sorted) {
      const day = startOfDay(new Date(ev.starts_at));
      const key = dayKey(day);
      if (!byDay.has(key)) byDay.set(key, { day, items: [] });
      byDay.get(key)!.items.push(ev);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }, [events]);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton h-10 w-full" />
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3">
        <div className="text-4xl opacity-30 dark-icon">🗓️</div>
        <div className="text-sm text-[var(--muted)]">No events in the next 30 days</div>
      </div>
    );
  }

  const today = new Date();

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map(({ day, items }) => (
        <div key={dayKey(day)}>
          <div
            className={`sticky top-0 px-4 py-2 bg-[var(--bg-secondary)]/80 backdrop-blur-xl text-[10px] font-bold tracking-widest uppercase border-b border-[var(--border)] ${
              isSameDay(day, today) ? "text-amber-accent" : "text-[var(--text-secondary)]"
            }`}
          >
            {fmtDayHeader(day)}
          </div>
          {items.map((ev) => {
            const entity = entitiesById.get(ev.entity_id);
            const color = colorForType(ev.type);
            const evConflicts = conflictsByEventId.get(ev.id) ?? [];
            return (
              <div
                key={ev.id}
                id={`cal-ev-${ev.id}`}
                onClick={() => onEventClick(ev)}
                className={`px-4 py-3 border-b border-[var(--border)] flex items-center gap-3 hover:bg-amber-accent/5 cursor-pointer ${
                  highlightIds.has(ev.id) ? "ring-2 ring-[var(--danger)]" : ""
                }`}
              >
                <span className={`w-2 h-2 rounded-full bp-keep-round shrink-0 ${color.dot}`} />
                <span className="font-mono text-xs text-[var(--text-secondary)] w-28 shrink-0">
                  {fmtTime(ev.starts_at)}–{fmtTime(ev.ends_at)}
                </span>
                <span className="text-sm text-[var(--text-primary)] font-medium truncate">{ev.title}</span>
                <span className="text-xs text-[var(--muted)] shrink-0">{entity?.name ?? `#${ev.entity_id}`}</span>
                <span className="px-1.5 rounded bg-amber-accent/10 border border-amber-accent/20 text-[10px] shrink-0">
                  {ev.type}
                </span>
                {evConflicts.length > 0 && (
                  <span
                    className="ml-auto px-2 py-0.5 rounded-full bg-[var(--danger-soft)] border border-[var(--danger)]/30 text-[var(--danger)] text-[10px] font-bold uppercase tracking-wider shrink-0"
                    title={evConflicts.map((c) => c.reason).join("\n")}
                  >
                    Conflict
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
