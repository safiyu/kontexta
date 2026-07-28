"use client";

import { Dialog } from "../ui/dialog";

interface GitErrorDialogProps {
  open: boolean;
  onClose: () => void;
  error: string;
  title?: string;
}

export function GitErrorDialog({ open, onClose, error, title = "Save failed" }: GitErrorDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="text-sm text-[var(--text-primary)] mb-4 leading-relaxed">
        Your changes were saved to the database, but Kontexta could not create a Git history entry for this file.
      </p>

      <div className="bg-[var(--danger-soft)] border border-[var(--danger)]/20 rounded-lg p-4 mb-6">
        <p className="text-[11px] text-[var(--danger)] uppercase tracking-tighter font-bold mb-2 opacity-70">Git error detail:</p>
        <pre className="text-[12px] font-mono text-[var(--danger)] whitespace-pre-wrap break-words leading-tight overflow-x-auto max-h-48 custom-scrollbar">
          {error}
        </pre>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="btn btn-md btn-destructive"
        >
          Got it
        </button>
      </div>
    </Dialog>
  );
}
