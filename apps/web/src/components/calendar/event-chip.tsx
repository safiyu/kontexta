"use client";

import type { CalendarEvent } from "kxta-core";
import { fmtTime } from "./date-utils";
import { colorForType } from "./event-colors";

interface EventChipProps {
  event: CalendarEvent;
  entityName: string;
  allDay: boolean;
  conflicted: boolean;
  highlighted: boolean;
  onClick: (e: React.MouseEvent) => void;
}

export function EventChip({ event, entityName, allDay, conflicted, highlighted, onClick }: EventChipProps) {
  const color = colorForType(event.type);
  return (
    <button
      id={`cal-ev-${event.id}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={`w-full text-left truncate rounded px-1.5 py-0.5 text-[11px] border ${color.chip} ${
        conflicted ? "ring-1 ring-red-400/70" : ""
      } ${highlighted ? "ring-2 ring-red-400" : ""}`}
      title={`${entityName} — ${event.title}`}
    >
      {!allDay && (
        <>
          <span className="font-mono opacity-70">{fmtTime(event.starts_at)}</span>{" "}
        </>
      )}
      <span className="font-bold">{entityName}</span> · {event.title}
    </button>
  );
}
