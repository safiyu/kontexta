"use client";

import { useState, useEffect } from "react";
import { Dialog } from "../ui/dialog";

interface NewFolderDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<boolean>;
}

export function NewFolderDialog({ open, onClose, onCreate }: NewFolderDialogProps) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    try {
      const created = await onCreate(name);
      // Only clear the form and close on success — onCreate already shows a
      // toast on failure, and the typed name must survive so the user can
      // fix and retry rather than losing it silently.
      if (created) {
        setName("");
        onClose();
      }
    } catch (error) {
      console.error("Failed to create folder:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New folder">
      <form onSubmit={handleSubmit}>
        <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">FOLDER NAME</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. documentation"
          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
          autoFocus
          required
        />
        <p className="text-[10px] text-[var(--text-secondary)] mt-2 italic">
          Folder will be created in the Knowledge Base.
        </p>

        <div className="flex justify-end gap-3 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-md"
          >
            CANCEL
          </button>
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="btn btn-md"
          >
            {loading ? "CREATING..." : "CREATE FOLDER"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
