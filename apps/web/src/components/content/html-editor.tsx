"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";

export function HtmlEditor({
  fileId,
  initial,
  onClose,
  onSaved,
}: {
  fileId: number;
  initial: string;
  onClose: () => void;
  onSaved: (updatedFile: any) => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/files/${fileId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: value }),
      });
      if (!res.ok) {
        alert("Save failed");
        return;
      }
      const updatedFile = await res.json();
      onSaved(updatedFile);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={true} onClose={onClose} title="Edit HTML source" widthClass="max-w-4xl">
      <div className="flex flex-col gap-4" style={{ height: "min(70vh, 600px)" }}>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 font-mono text-sm p-3 border border-[var(--border)] rounded resize-none bg-[var(--bg-secondary)] text-[var(--text-primary)]"
          spellCheck={false}
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-md">
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
