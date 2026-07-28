"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEntity, CalendarEvent } from "kxta-core";
import { weekDays, layoutDayEvents, isSameDay, HOURS, fmtTime, fmtDayLabel } from "./date-utils";
import { colorForType } from "./event-colors";

interface WeekViewProps {
  anchor: Date;
  events: CalendarEvent[];
  entitiesById: Map<number, CalendarEntity>;
  conflictEventIds: Set<number>;
  highlightIds: Set<number>;
  loading: boolean;
  onSlotClick: (day: Date, hour: number) => void;
  onEventClick: (ev: CalendarEvent) => void;
}

const PX_PER_HOUR = 48;

function CurrentTimeIndicator({ day }: { day: Date }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!isSameDay(day, now)) return null;
  const top = (now.getHours() * 60 + now.getMinutes()) * (PX_PER_HOUR / 60);
  return (
    <div className="absolute left-0 right-0 pointer-events-none z-10" style={{ top }}>
      <div className="h-px bg-amber-accent shadow-[0_0_6px_var(--accent-soft)]" />
      <div className="w-2 h-2 rounded-full bp-keep-round bg-amber-accent -ml-1 -mt-1" />
    </div>
  );
}

export function WeekView({ anchor, events, entitiesById, conflictEventIds, highlightIds, loading, onSlotClick, onEventClick }: WeekViewProps) {
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const today = new Date();

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 8 * PX_PER_HOUR;
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden p-4 gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton h-8 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex sticky top-0 z-10 bg-[var(--bg-secondary)]/80 backdrop-blur-xl border-b border-[var(--border)]">
        <div className="w-14 shrink-0" />
        <div className="grid grid-cols-7 flex-1">
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className={`text-center py-2 text-xs font-bold ${isSameDay(day, today) ? "text-amber-accent" : "text-[var(--text-secondary)]"}`}
            >
              {fmtDayLabel(day)}
            </div>
          ))}
        </div>
      </div>

      <div ref={bodyRef} className="flex-1 overflow-y-auto flex">
        <div className="w-14 shrink-0">
          {HOURS.map((h) => (
            <div key={h} className="text-[10px] text-[var(--muted)] text-right pr-2 font-mono" style={{ height: PX_PER_HOUR }}>
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 flex-1">
          {days.map((day) => {
            const positioned = layoutDayEvents(events, day);
            return (
              <div
                key={day.toISOString()}
                className="relative border-l border-[var(--border)]"
                style={{ height: 24 * PX_PER_HOUR }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const offsetY = e.clientY - rect.top;
                  onSlotClick(day, Math.floor(offsetY / PX_PER_HOUR));
                }}
              >
                {HOURS.map((h) => (
                  <div key={h} className="absolute left-0 right-0 border-t border-[var(--border)]" style={{ top: h * PX_PER_HOUR }} />
                ))}

                <CurrentTimeIndicator day={day} />

                {positioned.map(({ event, lane, lanes, topMin, heightMin }) => {
                  const color = colorForType(event.type);
                  const entityName = entitiesById.get(event.entity_id)?.name ?? `#${event.entity_id}`;
                  return (
                    <button
                      key={event.id}
                      id={`cal-ev-${event.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick(event);
                      }}
                      className={`absolute rounded-md border px-1.5 py-0.5 text-[11px] leading-tight overflow-hidden text-left cursor-pointer ${color.chip} ${
                        conflictEventIds.has(event.id) ? "ring-1 ring-red-400/70" : ""
                      } ${highlightIds.has(event.id) ? "ring-2 ring-red-400" : ""}`}
                      style={{
                        top: topMin * (PX_PER_HOUR / 60),
                        height: heightMin * (PX_PER_HOUR / 60),
                        left: `${(lane / lanes) * 100}%`,
                        width: `calc(${100 / lanes}% - 2px)`,
                      }}
                      title={`${entityName} — ${event.title}`}
                    >
                      <div className="font-semibold truncate">
                        <span className="font-bold">{entityName}</span> · {event.title}
                      </div>
                      <div className="opacity-70 font-mono text-[10px]">
                        {fmtTime(event.starts_at)}–{fmtTime(event.ends_at)}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
