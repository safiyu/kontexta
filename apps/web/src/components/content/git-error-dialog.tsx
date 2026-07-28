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

      <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4 mb-6">
        <p className="text-[11px] text-red-500 uppercase tracking-tighter font-bold mb-2 opacity-70">Git error detail:</p>
        <pre className="text-[12px] font-mono text-red-400 whitespace-pre-wrap break-words leading-tight overflow-x-auto max-h-48 custom-scrollbar">
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
