"use client";

import { useState, useEffect } from "react";
import { Dialog } from "../ui/dialog";

interface NewFolderDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<boolean>;
  /**
   * When set (KB context), the dialog treats the new folder as a subfolder
   * inside this bucket — the prefix is displayed but not typed, and the
   * submitted name becomes `<bucketPrefix>/<user input>`.
   */
  bucketPrefix?: string | null;
}

export function NewFolderDialog({ open, onClose, onCreate, bucketPrefix }: NewFolderDialogProps) {
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
      // Wire format is POSIX — flip any pasted `\` to `/` so tree keys match.
      const cleanedName = name.trim()
        .replace(/\\+/g, "/")
        .replace(/^\/+|\/+$/g, "");
      const fullName = bucketPrefix ? `${bucketPrefix}/${cleanedName}` : cleanedName;
      const created = await onCreate(fullName);
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
    <Dialog open={open} onClose={onClose} title={bucketPrefix ? `New folder inside ${bucketPrefix}/` : "New folder"}>
      <form onSubmit={handleSubmit}>
        <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">FOLDER NAME</label>
        {bucketPrefix ? (
          <div className="flex items-stretch">
            <span className="inline-flex items-center px-2 rounded-l bg-[var(--bg-tertiary)] border border-[var(--border)] border-r-0 text-sm text-[var(--text-secondary)] font-mono">
              {bucketPrefix}/
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 2026/09"
              className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-r px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
              autoFocus
              required
            />
          </div>
        ) : (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. documentation"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
            autoFocus
            required
          />
        )}
        <p className="text-[10px] text-[var(--text-secondary)] mt-2 italic">
          {bucketPrefix
            ? `Creates knowledge/${bucketPrefix}/<name>/.`
            : "Folder will be created inside the selected project."}
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
