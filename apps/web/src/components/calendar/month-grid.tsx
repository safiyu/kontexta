"use client";

import { useMemo } from "react";
import type { CalendarEntity, CalendarEvent } from "kxta-core";
import { monthGrid, maxVisibleForWeeks, eventTouchesDay, isAllDayForDay, isSameDay, startOfDay } from "./date-utils";
import { EventChip } from "./event-chip";

interface MonthGridProps {
  anchor: Date;
  events: CalendarEvent[];
  entitiesById: Map<number, CalendarEntity>;
  conflictEventIds: Set<number>;
  highlightIds: Set<number>;
  loading: boolean;
  onSlotClick: (day: Date) => void;
  onEventClick: (ev: CalendarEvent) => void;
  onShowDay: (day: Date) => void;
}

const WEEKDAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function dayKey(d: Date): string {
  return startOfDay(d).toISOString();
}

export function MonthGrid({ anchor, events, entitiesById, conflictEventIds, highlightIds, loading, onSlotClick, onEventClick, onShowDay }: MonthGridProps) {
  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const weeks = grid.length / 7;
  const maxVisible = maxVisibleForWeeks(weeks);
  const rowsStyle = { gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` };

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const day of grid) {
      const dayEvents = events
        .filter((ev) => eventTouchesDay(ev, day))
        .sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
      map.set(dayKey(day), dayEvents);
    }
    return map;
  }, [grid, events]);

  const today = new Date();

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="grid grid-cols-7 text-[10px] font-bold tracking-widest uppercase text-[var(--muted)] border-b border-[var(--border)]">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="px-2 py-1.5">{label}</div>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-7 flex-1" style={rowsStyle}>
          {grid.map((day) => (
            <div key={dayKey(day)} className="border-b border-r border-[var(--border)] p-1.5">
              <div className="skeleton h-4 w-4 rounded-full bp-keep-round" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-7 flex-1 overflow-y-auto" style={rowsStyle}>
          {grid.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const isToday = isSameDay(day, today);
            const dayEvents = eventsByDay.get(dayKey(day)) ?? [];
            const visible = dayEvents.slice(0, maxVisible);
            const overflow = dayEvents.length - visible.length;

            return (
              <div
                key={dayKey(day)}
                onClick={() => onSlotClick(day)}
                className={`border-b border-r border-[var(--border)] p-1.5 min-h-[96px] cursor-pointer hover:bg-amber-accent/5 flex flex-col gap-1 overflow-hidden ${
                  isToday ? "bg-amber-accent/5" : ""
                }`}
              >
                {isToday ? (
                  <span className="w-6 h-6 rounded-full bp-keep-round bg-amber-accent text-white flex items-center justify-center font-bold text-xs">
                    {day.getDate()}
                  </span>
                ) : (
                  <span className={`text-xs ${inMonth ? "text-[var(--text-primary)]" : "text-[var(--muted)] opacity-50"}`}>
                    {day.getDate()}
                  </span>
                )}
                {visible.map((ev) => (
                  <EventChip
                    key={ev.id}
                    event={ev}
                    entityName={entitiesById.get(ev.entity_id)?.name ?? `#${ev.entity_id}`}
                    allDay={isAllDayForDay(ev, day)}
                    conflicted={conflictEventIds.has(ev.id)}
                    highlighted={highlightIds.has(ev.id)}
                    onClick={() => onEventClick(ev)}
                  />
                ))}
                {overflow > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onShowDay(day);
                    }}
                    className="text-[10px] text-[var(--text-secondary)] hover:text-amber-accent text-left"
                  >
                    +{overflow} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
