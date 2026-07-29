"use client";

import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { CalendarEntity } from "kxta-core";
import type { ViewMode } from "./date-utils";

interface CalendarToolbarProps {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  rangeLabel: string;
  anchor: Date;
  onNavigate: (dir: -1 | 0 | 1) => void;
  onJumpToDate: (date: Date) => void;
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

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function CalendarToolbar({
  view, onViewChange, rangeLabel, anchor, onNavigate, onJumpToDate,
  entities, entityFilter, onEntityFilter,
  types, typeFilter, onTypeFilter,
  query, onQueryChange,
  conflictCount, conflictsOpen, onToggleConflicts,
  onExportIcs, onManageEntities, onNewEvent,
}: CalendarToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(anchor.getFullYear());

  function jumpToMonth(monthIndex: number) {
    onJumpToDate(new Date(pickerYear, monthIndex, 1));
    setPickerOpen(false);
  }

  function jumpToToday() {
    onJumpToDate(new Date());
    setPickerOpen(false);
  }

  return (
    <div className="border-b border-[var(--border)]">
      {/* Row 1: navigation + range + view switcher — never competes with filters/actions for space. */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <div className="flex items-center gap-1">
          <button className="btn btn-sm" onClick={() => onNavigate(-1)} aria-label="Previous">
            <ChevronLeft className="w-4 h-4" aria-hidden />
          </button>
          <button className="btn btn-sm" onClick={() => onNavigate(0)}>Today</button>
          <button className="btn btn-sm" onClick={() => onNavigate(1)} aria-label="Next">
            <ChevronRight className="w-4 h-4" aria-hidden />
          </button>
        </div>

        <Menu.Root
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open);
            if (open) setPickerYear(anchor.getFullYear());
          }}
        >
          <Menu.Trigger asChild>
            <button
              type="button"
              className="font-title text-lg font-bold text-[var(--text-primary)] mx-2 whitespace-nowrap truncate hover:text-amber-accent transition-colors"
              aria-label="Jump to a different month"
            >
              {rangeLabel}
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content align="start" sideOffset={6} className="z-[var(--z-dropdown)]">
              <div className="w-56 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 shadow-xl animate-scale-in">
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={() => setPickerYear((y) => y - 1)}
                    className="btn btn-icon-sm"
                    aria-label="Previous year"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" aria-hidden />
                  </button>
                  <span className="text-xs font-bold text-[var(--text-primary)]">{pickerYear}</span>
                  <button
                    type="button"
                    onClick={() => setPickerYear((y) => y + 1)}
                    className="btn btn-icon-sm"
                    aria-label="Next year"
                  >
                    <ChevronRight className="w-3.5 h-3.5" aria-hidden />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {MONTH_LABELS.map((label, i) => {
                    const isTarget = pickerYear === anchor.getFullYear() && i === anchor.getMonth();
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => jumpToMonth(i)}
                        className={`rounded px-2 py-1.5 text-[11px] font-medium transition-colors ${
                          isTarget
                            ? "bg-amber-accent/15 text-amber-accent border border-amber-accent/40"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={jumpToToday}
                  className="mt-2 w-full text-center text-[10px] font-bold uppercase tracking-widest text-amber-accent hover:opacity-80"
                >
                  Today
                </button>
              </div>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>

        <div className="flex-1" />

        <div className="flex rounded-lg border border-[var(--border)] overflow-hidden shrink-0">
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
      </div>

      {/* Row 2: filters + actions — has the full width to itself, so it only wraps at genuinely narrow widths. */}
      <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
        <select
          value={entityFilter ?? ""}
          onChange={(e) => onEntityFilter(e.target.value ? Number(e.target.value) : undefined)}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer min-w-0"
        >
          <option value="">All entities</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>

        <select
          value={typeFilter ?? ""}
          onChange={(e) => onTypeFilter(e.target.value || undefined)}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer min-w-0"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <div className="relative min-w-[8rem] flex-1 max-w-48">
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter: entity, title, type…"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 pr-6 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50 placeholder:text-[var(--muted)]"
          />
          {query && (
            <button
              onClick={() => onQueryChange("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-amber-accent text-xs px-1"
              aria-label="Clear filter"
            >
              <X className="w-3.5 h-3.5" aria-hidden />
            </button>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2 flex-wrap justify-end">
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
          <button className="btn btn-sm btn-primary" onClick={onNewEvent}>+ New event</button>
        </div>
      </div>
    </div>
  );
}
