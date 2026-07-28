"use client";

import { useState } from "react";
import type { CalendarEntity, CalendarEvent } from "kxta-core";
import { fromDatetimeLocalValue } from "./date-utils";
import { Dialog } from "../ui/dialog";
import { ConfirmDialog } from "../ui/confirm-dialog";

export type EventDialogState =
  | { mode: "create"; entityId?: number; startsAt: string; endsAt: string }
  | { mode: "edit"; event: CalendarEvent };

interface EventDialogProps {
  state: EventDialogState;
  entities: CalendarEntity[];
  knownTypes: string[];
  onClose: () => void;
  onSaved: () => void;
}

const inputClass =
  "w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50";
const labelClass = "block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5 uppercase";

export function EventDialog({ state, entities, knownTypes, onClose, onSaved }: EventDialogProps) {
  const isEdit = state.mode === "edit";
  const event = isEdit ? state.event : null;

  const [entityId, setEntityId] = useState<number | "">(
    isEdit ? event!.entity_id : state.entityId ?? entities[0]?.id ?? ""
  );
  const [type, setType] = useState(isEdit ? event!.type : "");
  const [title, setTitle] = useState(isEdit ? event!.title : "");
  const [startsAt, setStartsAt] = useState(isEdit ? toLocal(event!.starts_at) : state.startsAt);
  const [endsAt, setEndsAt] = useState(isEdit ? toLocal(event!.ends_at) : state.endsAt);
  const [notes, setNotes] = useState(isEdit ? event!.notes ?? "" : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  function toLocal(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function handleSave() {
    setError(null);
    if (!entityId || !type.trim() || !title.trim() || !startsAt || !endsAt) {
      setError("Entity, type, title, start, and end are all required.");
      return;
    }
    if (endsAt <= startsAt) {
      setError("End must be after start.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        entity_id: Number(entityId),
        type: type.trim(),
        title: title.trim(),
        notes: notes.trim() || undefined,
        starts_at: fromDatetimeLocalValue(startsAt),
        ends_at: fromDatetimeLocalValue(endsAt),
        original_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      const res = isEdit
        ? await fetch(`/api/calendar/events/${event!.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/calendar/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, source: "web" }),
          });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to save event.");
        return;
      }

      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setConfirmDeleteOpen(false);
    setSaving(true);
    try {
      const res = await fetch(`/api/calendar/events/${event!.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to delete event.");
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={isEdit ? "Edit event" : "New event"} widthClass="max-w-lg">
      <div className="space-y-4">
        <div>
          <label className={labelClass}>Entity</label>
          <select
            value={entityId}
            onChange={(e) => setEntityId(e.target.value ? Number(e.target.value) : "")}
            className={`${inputClass} cursor-pointer`}
          >
            <option value="">Select an entity…</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Type</label>
            <input
              type="text"
              list="calendar-event-types"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="Freeform — any label you like"
              className={inputClass}
            />
            <datalist id="calendar-event-types">
              {knownTypes.map((t) => <option key={t} value={t} />)}
            </datalist>
          </div>
          <div>
            <label className={labelClass}>Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Starts</label>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Ends</label>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputClass} />
          </div>
        </div>

        <div>
          <label className={labelClass}>Notes</label>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </div>

        {error && <div className="text-xs text-[var(--danger)]">{error}</div>}
      </div>

      <div className="pt-4 mt-4 border-t border-[var(--border)] flex items-center justify-between gap-3">
        {isEdit ? (
          <button onClick={() => setConfirmDeleteOpen(true)} disabled={saving} className="btn btn-sm btn-destructive">
            Delete
          </button>
        ) : (
          <div />
        )}
        <div className="flex gap-3">
          <button onClick={onClose} disabled={saving} className="btn btn-sm">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn btn-sm !text-amber-accent font-bold">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Delete event?"
        message="This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={saving}
      />
    </Dialog>
  );
}
