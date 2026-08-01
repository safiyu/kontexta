"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { CalendarEntity, CalendarLink } from "kxta-core";
import { Dialog } from "../ui/dialog";
import { ConfirmDialog } from "../ui/confirm-dialog";

interface EntityManagerProps {
  open: boolean;
  onClose: () => void;
  entities: CalendarEntity[];
  links: CalendarLink[];
  onChanged: () => void;
}

const inputClass =
  "bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-amber-accent/50";

export function EntityManager({ open, onClose, entities, links, onChanged }: EntityManagerProps) {
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("");
  const [newTimezone, setNewTimezone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteEntity, setConfirmDeleteEntity] = useState<CalendarEntity | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [linkFrom, setLinkFrom] = useState<number | "">("");
  const [linkTo, setLinkTo] = useState<number | "">("");
  const [linkLabel, setLinkLabel] = useState("");

  async function addEntity() {
    setError(null);
    if (!newName.trim()) return;
    const res = await fetch("/api/calendar/entities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), kind: newKind.trim() || undefined, timezone: newTimezone.trim() || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to add entity.");
      return;
    }
    setNewName("");
    setNewKind("");
    setNewTimezone("");
    onChanged();
  }

  async function toggleActive(entity: CalendarEntity) {
    setError(null);
    const res = await fetch(`/api/calendar/entities/${entity.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !entity.active }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to update entity.");
      return;
    }
    onChanged();
  }

  async function performDeleteEntity() {
    const entity = confirmDeleteEntity;
    if (!entity) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/calendar/entities/${entity.id}`, { method: "DELETE" });
      if (!res.ok) {
        // The ConfirmDialog stays open (rendered above this component's own
        // Dialog), so an inline `error` state here would be invisible behind
        // it — use a toast, which floats above every open modal.
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Failed to delete entity.");
        return;
      }
      setConfirmDeleteEntity(null);
      toast.success(`Deleted "${entity.name}"`);
      onChanged();
    } finally {
      setDeleting(false);
    }
  }

  async function addLink() {
    setError(null);
    if (!linkFrom || !linkTo || linkFrom === linkTo) {
      setError("Choose two different entities.");
      return;
    }
    const res = await fetch("/api/calendar/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_entity_id: linkFrom, to_entity_id: linkTo, label: linkLabel.trim() || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to add link.");
      return;
    }
    setLinkFrom("");
    setLinkTo("");
    setLinkLabel("");
    onChanged();
  }

  async function removeLink(link: CalendarLink) {
    setError(null);
    const res = await fetch(`/api/calendar/links?from=${link.from_entity_id}&to=${link.to_entity_id}`, { method: "DELETE" });
    if (!res.ok) return;
    onChanged();
  }

  function entityName(id: number): string {
    return entities.find((e) => e.id === id)?.name ?? `#${id}`;
  }

  return (
    <Dialog open={open} onClose={onClose} title="Manage entities & links" widthClass="max-w-3xl">
      <div className="space-y-6">
        {error && <div className="text-xs text-[var(--danger)]">{error}</div>}

        <section>
            <h4 className="text-xs font-bold tracking-widest uppercase text-[var(--text-secondary)] mb-3">Entities</h4>
            <div className="flex gap-2 mb-3">
              <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} className={`${inputClass} flex-1`} />
              <input placeholder="Kind" value={newKind} onChange={(e) => setNewKind(e.target.value)} className={`${inputClass} w-28`} />
              <input placeholder="Timezone" value={newTimezone} onChange={(e) => setNewTimezone(e.target.value)} className={`${inputClass} w-36`} />
              <button onClick={addEntity} className="btn btn-sm btn-primary">Add</button>
            </div>
            <div className="space-y-1.5">
              {entities.map((entity) => (
                <div key={entity.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-amber-accent/5">
                  <span className={`w-1.5 h-1.5 rounded-full bp-keep-round shrink-0 ${entity.active ? "bg-[var(--success)]" : "bg-[var(--muted)]"}`} />
                  <span className="text-sm text-[var(--text-primary)] flex-1 truncate">{entity.name}</span>
                  {entity.kind && <span className="text-xs text-[var(--muted)] shrink-0">{entity.kind}</span>}
                  {entity.timezone && <span className="text-xs text-[var(--muted)] shrink-0 font-mono">{entity.timezone}</span>}
                  <button onClick={() => toggleActive(entity)} className="btn btn-sm shrink-0">
                    {entity.active ? "Retire" : "Reactivate"}
                  </button>
                  <button onClick={() => setConfirmDeleteEntity(entity)} className="btn btn-sm btn-destructive shrink-0">
                    Delete
                  </button>
                </div>
              ))}
              {entities.length === 0 && <div className="text-xs text-[var(--muted)] py-2">No entities yet.</div>}
            </div>
        </section>

        <section>
            <h4 className="text-xs font-bold tracking-widest uppercase text-[var(--text-secondary)] mb-3">Links</h4>
            <div className="flex gap-2 mb-3">
              <select value={linkFrom} onChange={(e) => setLinkFrom(e.target.value ? Number(e.target.value) : "")} className={`${inputClass} flex-1 cursor-pointer`}>
                <option value="">From…</option>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <select value={linkTo} onChange={(e) => setLinkTo(e.target.value ? Number(e.target.value) : "")} className={`${inputClass} flex-1 cursor-pointer`}>
                <option value="">To…</option>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <input placeholder="Label" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} className={`${inputClass} w-32`} />
              <button onClick={addLink} className="btn btn-sm btn-primary">Add</button>
            </div>
            <div className="space-y-1.5">
              {links.map((link) => (
                <div key={link.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-amber-accent/5">
                  <span className="text-sm text-[var(--text-primary)] flex-1">
                    {entityName(link.from_entity_id)} → {entityName(link.to_entity_id)}
                  </span>
                  {link.label && (
                    <span className="px-1.5 rounded bg-amber-accent/10 border border-amber-accent/20 text-[10px] shrink-0">
                      {link.label}
                    </span>
                  )}
                  <button onClick={() => removeLink(link)} className="btn btn-sm btn-destructive shrink-0">Remove</button>
                </div>
              ))}
              {links.length === 0 && <div className="text-xs text-[var(--muted)] py-2">No links yet.</div>}
            </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDeleteEntity !== null}
        onClose={() => setConfirmDeleteEntity(null)}
        onConfirm={performDeleteEntity}
        title="Delete entity?"
        message={
          <>
            Deleting {confirmDeleteEntity ? <strong className="text-[var(--text-primary)]">&quot;{confirmDeleteEntity.name}&quot;</strong> : "this entity"} also
            deletes all of its events and links. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        loading={deleting}
      />
    </Dialog>
  );
}
