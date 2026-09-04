"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";

export function HtmlEditor({
  fileId,
  initial,
  expectedUpdatedAt,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  fileId: number;
  initial: string;
  expectedUpdatedAt: string;
  onClose: () => void;
  onSaved: (updatedFile: any) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = value !== initial;

  function requestClose() {
    if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
    onClose();
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/files/${fileId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: value, expected_updated_at: expectedUpdatedAt }),
      });
      if (res.status === 409) {
        toast.error("This file changed elsewhere since you opened it — reload before saving to avoid overwriting the newer version.");
        return;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        toast.error(`Save failed${body ? `: ${body}` : ""}`);
        return;
      }
      const updatedFile = await res.json();
      onSaved(updatedFile);
      onClose();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={true} onClose={requestClose} title="Edit HTML source" widthClass="max-w-4xl">
      <div className="flex flex-col gap-4" style={{ height: "min(70vh, 600px)" }}>
        <textarea
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            setValue(v);
            onDirtyChange?.(v !== initial);
          }}
          className="flex-1 font-mono text-sm p-3 border border-[var(--border)] rounded resize-none bg-[var(--bg-secondary)] text-[var(--text-primary)]"
          spellCheck={false}
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={requestClose} disabled={busy} className="btn btn-md">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy} className="btn btn-md">
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
