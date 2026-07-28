"use client";

import { useEffect, useState } from "react";
import type { CalendarEntity, Conflict } from "kxta-core";
import { fmtTime } from "./date-utils";

interface ConflictsPanelProps {
  conflicts: Conflict[];
  bufferMinutes: number;
  loading: boolean;
  entitiesById: Map<number, CalendarEntity>;
  onFocusConflict: (c: Conflict) => void;
  onBufferSaved: () => void;
  onClose: () => void;
}

function kindClasses(kind: Conflict["kind"]): string {
  if (kind === "insufficient_buffer") return "bg-amber-500/10 border-amber-500/30 text-amber-400";
  return "bg-[var(--danger-soft)] border-[var(--danger)]/30 text-[var(--danger)]";
}

function kindLabel(kind: Conflict["kind"]): string {
  if (kind === "overlap") return "Overlap";
  if (kind === "linked_overlap") return "Linked overlap";
  return "Insufficient buffer";
}

export function ConflictsPanel({ conflicts, bufferMinutes, loading, entitiesById, onFocusConflict, onBufferSaved, onClose }: ConflictsPanelProps) {
  const [bufferInput, setBufferInput] = useState(String(bufferMinutes));
  const [saving, setSaving] = useState(false);

  // bufferMinutes arrives asynchronously (fetched setting); re-sync the local
  // input string once the real value loads instead of showing a stale default.
  useEffect(() => {
    setBufferInput(String(bufferMinutes));
  }, [bufferMinutes]);

  async function saveBuffer() {
    const n = Number(bufferInput);
    if (!Number.isInteger(n) || n < 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/calendar/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buffer_minutes: n }),
      });
      if (res.ok) onBufferSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-80 shrink-0 floating-surface rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-fade-in">
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between shrink-0">
        <span className="text-xs font-bold tracking-widest uppercase text-amber-accent">Conflicts</span>
        <div className="flex items-center gap-2">
          {conflicts.length > 0 && (
            <span className="px-1.5 rounded-full bg-[var(--danger-soft)] text-[var(--danger)] text-[10px] font-bold">{conflicts.length}</span>
          )}
          <button onClick={onClose} className="btn btn-icon-sm" aria-label="Close conflicts panel">✕</button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2 shrink-0">
        <label className="text-[10px] font-bold text-[var(--text-secondary)] tracking-widest uppercase flex-1">
          Min buffer (minutes)
        </label>
        <input
          type="number"
          min={0}
          value={bufferInput}
          onChange={(e) => setBufferInput(e.target.value)}
          className="w-16 bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
        />
        <button onClick={saveBuffer} disabled={saving} className="btn btn-sm">Save</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton h-16 w-full rounded-lg" />)}
          </div>
        ) : conflicts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <div className="text-3xl opacity-30 dark-icon">✅</div>
            <div className="text-xs text-[var(--muted)]">No conflicts in view</div>
          </div>
        ) : (
          conflicts.map((c, i) => {
            const entityA = entitiesById.get(c.entity_a.id);
            const entityB = entitiesById.get(c.entity_b.id);
            return (
              <div
                key={i}
                onClick={() => onFocusConflict(c)}
                className={`mx-3 my-2 p-3 rounded-lg border cursor-pointer hover:border-opacity-50 ${kindClasses(c.kind)}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider">{kindLabel(c.kind)}</span>
                  {c.gap_minutes !== null && <span className="text-[10px] font-mono">{c.gap_minutes}m gap</span>}
                </div>
                <div className="text-xs text-[var(--text-primary)] space-y-0.5 mb-1.5">
                  <div>{c.event_a.title} — {fmtTime(c.event_a.starts_at)} ({entityA?.name ?? c.entity_a.name})</div>
                  <div>{c.event_b.title} — {fmtTime(c.event_b.starts_at)} ({entityB?.name ?? c.entity_b.name})</div>
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">{c.reason}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
