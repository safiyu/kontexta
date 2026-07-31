"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import type { CalendarEntity, CalendarEvent, Conflict } from "kxta-core";
import { useEntities, useCalendarData } from "@/hooks/use-calendar";
import {
  visibleRange, addDays, addMonths, toDatetimeLocalValue, fmtMonthTitle, fmtRangeLabel,
  type ViewMode,
} from "./date-utils";
import { CalendarToolbar } from "./toolbar";
import { MonthGrid } from "./month-grid";
import { WeekView } from "./week-view";
import { AgendaList } from "./agenda-list";
import { EventDialog, type EventDialogState } from "./event-dialog";
import { EntityManager } from "./entity-manager";
import { ConflictsPanel } from "./conflicts-panel";

export function CalendarClient() {
  const router = useRouter();
  const [view, setView] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [entityFilter, setEntityFilter] = useState<number | undefined>();
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<EventDialogState | null>(null);
  const [entityManagerOpen, setEntityManagerOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(true);
  const [highlightIds, setHighlightIds] = useState<Set<number>>(new Set());

  const { entities, links, loading: entitiesLoading, refresh: refreshEntities } = useEntities();

  const { from, to } = useMemo(() => visibleRange(view, anchor), [view, anchor]);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const {
    events, conflicts, bufferMinutes, loading: dataLoading, refresh: refreshData,
  } = useCalendarData({ fromIso, toIso, entityId: entityFilter, type: typeFilter });

  const refreshAll = useCallback(() => {
    refreshEntities();
    refreshData();
  }, [refreshEntities, refreshData]);

  const entitiesById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const conflictEventIds = useMemo(() => {
    const set = new Set<number>();
    for (const c of conflicts) {
      set.add(c.event_a.id);
      set.add(c.event_b.id);
    }
    return set;
  }, [conflicts]);
  const types = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);

  // Free-text filter: show ONLY events matching the query against title,
  // entity name, type, notes, or source (case-insensitive).
  const visibleEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((ev) => {
      const entityName = entitiesById.get(ev.entity_id)?.name ?? "";
      return (
        ev.title.toLowerCase().includes(q) ||
        entityName.toLowerCase().includes(q) ||
        ev.type.toLowerCase().includes(q) ||
        (ev.notes ?? "").toLowerCase().includes(q) ||
        (ev.source ?? "").toLowerCase().includes(q)
      );
    });
  }, [events, query, entitiesById]);

  function handleNavigate(dir: -1 | 0 | 1) {
    setHighlightIds(new Set());
    if (dir === 0) {
      setAnchor(new Date());
      return;
    }
    if (view === "month") {
      setAnchor((a) => addMonths(a, dir));
    } else if (view === "week") {
      setAnchor((a) => addDays(a, dir * 7));
    } else {
      setAnchor((a) => addDays(a, dir * 30));
    }
  }

  function handleJumpToDate(date: Date) {
    setHighlightIds(new Set());
    setAnchor(date);
  }

  function handleSlotClick(day: Date, hour?: number) {
    // Entities may have been added elsewhere (MCP, another tab) since this
    // page loaded — refetch so the dialog's dropdown is never stale.
    refreshEntities();
    const start = new Date(day);
    start.setHours(hour ?? 9, 0, 0, 0);
    const end = new Date(start);
    end.setHours(start.getHours() + 1);
    setDialog({
      mode: "create",
      entityId: entityFilter,
      startsAt: toDatetimeLocalValue(start.toISOString()),
      endsAt: toDatetimeLocalValue(end.toISOString()),
    });
  }

  function handleEventClick(ev: CalendarEvent) {
    refreshEntities();
    setDialog({ mode: "edit", event: ev });
  }

  function handleConflictFocus(c: Conflict) {
    setAnchor(new Date(c.event_a.starts_at));
    setHighlightIds(new Set([c.event_a.id, c.event_b.id]));
    requestAnimationFrame(() => {
      const el = document.getElementById(`cal-ev-${c.event_a.id}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function handleExportIcs() {
    const params = new URLSearchParams({ from: fromIso, to: toIso });
    if (entityFilter !== undefined) params.append("entity_id", String(entityFilter));
    const url = `/api/calendar/ics?${params.toString()}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.click();
  }

  const rangeLabel = view === "month" ? fmtMonthTitle(anchor) : fmtRangeLabel(from, to);
  const loading = entitiesLoading || dataLoading;

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-[var(--bg-secondary)] dark:bg-[var(--bg-primary)]">
      <header className="sticky top-0 z-30 h-16 bg-[var(--bg-secondary)]/80 backdrop-blur-xl border-b border-[var(--border)] flex items-center px-6 gap-2">
        <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => router.push("/")}>
          <span className="text-sm text-[var(--text-secondary)] hover:text-amber-accent transition-colors">Home</span>
          <ChevronRight className="w-4 h-4 text-[var(--muted)] opacity-40" aria-hidden />
          <span className="text-sm font-bold text-amber-accent">Calendar</span>
        </div>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="btn btn-icon-md btn-outline ml-auto"
          aria-label="Close calendar and return to home"
          title="Close"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </header>

      <div className="flex-1 p-3 lg:p-4 flex gap-3 overflow-hidden">
        <main className="flex-1 min-w-0 floating-surface rounded-2xl shadow-2xl relative flex flex-col overflow-hidden">
          <div className="absolute inset-0 border border-amber-accent/10 rounded-2xl pointer-events-none z-20" />
          <CalendarToolbar
            view={view}
            onViewChange={setView}
            rangeLabel={rangeLabel}
            anchor={anchor}
            onNavigate={handleNavigate}
            onJumpToDate={handleJumpToDate}
            entities={entities}
            entityFilter={entityFilter}
            onEntityFilter={setEntityFilter}
            types={types}
            typeFilter={typeFilter}
            onTypeFilter={setTypeFilter}
            query={query}
            onQueryChange={setQuery}
            conflictCount={conflicts.length}
            conflictsOpen={conflictsOpen}
            onToggleConflicts={() => setConflictsOpen((o) => !o)}
            onExportIcs={handleExportIcs}
            onManageEntities={() => { refreshEntities(); setEntityManagerOpen(true); }}
            onNewEvent={() => handleSlotClick(new Date())}
          />

          {view === "month" && (
            <MonthGrid
              anchor={anchor}
              events={visibleEvents}
              entitiesById={entitiesById}
              conflictEventIds={conflictEventIds}
              highlightIds={highlightIds}
              loading={loading}
              onSlotClick={handleSlotClick}
              onEventClick={handleEventClick}
            />
          )}
          {view === "week" && (
            <WeekView
              anchor={anchor}
              events={visibleEvents}
              entitiesById={entitiesById}
              conflictEventIds={conflictEventIds}
              highlightIds={highlightIds}
              loading={loading}
              onSlotClick={handleSlotClick}
              onEventClick={handleEventClick}
            />
          )}
          {view === "agenda" && (
            <AgendaList
              events={visibleEvents}
              entitiesById={entitiesById}
              conflicts={conflicts}
              loading={loading}
              highlightIds={highlightIds}
              onEventClick={handleEventClick}
            />
          )}
        </main>

        {conflictsOpen && (
          <div className="hidden xl:flex">
            <ConflictsPanel
              conflicts={conflicts}
              bufferMinutes={bufferMinutes}
              loading={dataLoading}
              entitiesById={entitiesById}
              onFocusConflict={handleConflictFocus}
              onBufferSaved={refreshData}
              onClose={() => setConflictsOpen(false)}
            />
          </div>
        )}
      </div>

      {dialog && (
        <EventDialog
          state={dialog}
          entities={entities.filter((e: CalendarEntity) => e.active)}
          knownTypes={types}
          onClose={() => setDialog(null)}
          onSaved={refreshAll}
        />
      )}

      <EntityManager
        open={entityManagerOpen}
        onClose={() => setEntityManagerOpen(false)}
        entities={entities}
        links={links}
        onChanged={refreshAll}
      />
    </div>
  );
}
