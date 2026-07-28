"use client";

import type { CalendarEntity } from "kxta-core";
import type { ViewMode } from "./date-utils";

interface CalendarToolbarProps {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  rangeLabel: string;
  onNavigate: (dir: -1 | 0 | 1) => void;
  entities: CalendarEntity[];
  entityFilter?: number;
  onEntityFilter: (id?: number) => void;
  types: string[];
  typeFilter?: string;
  onTypeFilter: (t?: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  conflictCount: number;
  conflictsOpen: boolean;
  onToggleConflicts: () => void;
  onExportIcs: () => void;
  onManageEntities: () => void;
  onNewEvent: () => void;
}

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "agenda", label: "Agenda" },
];

export function CalendarToolbar({
  view, onViewChange, rangeLabel, onNavigate,
  entities, entityFilter, onEntityFilter,
  types, typeFilter, onTypeFilter,
  query, onQueryChange,
  conflictCount, conflictsOpen, onToggleConflicts,
  onExportIcs, onManageEntities, onNewEvent,
}: CalendarToolbarProps) {
  return (
    <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1">
        <button className="btn btn-sm" onClick={() => onNavigate(-1)} aria-label="Previous">‹</button>
        <button className="btn btn-sm" onClick={() => onNavigate(0)}>Today</button>
        <button className="btn btn-sm" onClick={() => onNavigate(1)} aria-label="Next">›</button>
      </div>

      <h2 className="font-title text-lg font-bold text-[var(--text-primary)] mx-2 whitespace-nowrap">
        {rangeLabel}
      </h2>

      <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => onViewChange(v.id)}
            className={`px-3 py-1.5 text-xs font-bold tracking-widest uppercase transition-colors ${
              view === v.id
                ? "bg-amber-accent/10 text-amber-accent"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <select
        value={entityFilter ?? ""}
        onChange={(e) => onEntityFilter(e.target.value ? Number(e.target.value) : undefined)}
        className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
      >
        <option value="">All entities</option>
        {entities.map((e) => (
          <option key={e.id} value={e.id}>{e.name}</option>
        ))}
      </select>

      <select
        value={typeFilter ?? ""}
        onChange={(e) => onTypeFilter(e.target.value || undefined)}
        className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
      >
        <option value="">All types</option>
        {types.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>

      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter: entity, title, type…"
          className="w-48 bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 pr-6 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 placeholder:text-[var(--muted)]"
        />
        {query && (
          <button
            onClick={() => onQueryChange("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-amber-accent text-xs px-1"
            aria-label="Clear filter"
          >
            ✕
          </button>
        )}
      </div>

      <div className="flex-1" />

      <button
        onClick={onToggleConflicts}
        className={`btn btn-sm flex items-center gap-1.5 ${conflictsOpen ? "bg-amber-accent/10 text-amber-accent" : ""}`}
      >
        Conflicts
        {conflictCount > 0 && (
          <span className="px-1.5 rounded-full bg-[var(--danger-soft)] text-[var(--danger)] text-[10px] font-bold">
            {conflictCount}
          </span>
        )}
      </button>

      <button className="btn btn-sm" onClick={onManageEntities}>Entities</button>
      <button className="btn btn-sm" onClick={onExportIcs}>Export ICS</button>
      <button className="btn btn-sm !text-amber-accent font-bold" onClick={onNewEvent}>+ New event</button>
    </div>
  );
}
