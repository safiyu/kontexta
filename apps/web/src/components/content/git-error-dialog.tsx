"use client";

import { Dialog } from "../ui/dialog";

interface GitErrorDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Explanatory sentence — states what actually happened to the user's data. */
  body: string;
  /** Optional technical detail (raw error/warning text) shown in a monospace box. */
  detail?: string;
}

/**
 * Generic save-outcome dialog used for git warnings, save conflicts, and
 * save failures alike. `title`/`body` are required (not defaulted) so every
 * call site must say something accurate about whether the save actually
 * happened — a git-commit warning ("saved, but...") and a failed save
 * ("not saved") must never share the same body text.
 */
export function GitErrorDialog({ open, onClose, title, body, detail }: GitErrorDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="text-sm text-[var(--text-primary)] mb-4 leading-relaxed">
        {body}
      </p>

      {detail && (
        <div className="bg-[var(--danger-soft)] border border-[var(--danger)]/20 rounded-lg p-4 mb-6">
          <p className="text-[11px] text-[var(--danger)] uppercase tracking-tighter font-bold mb-2 opacity-70">Detail:</p>
          <pre className="text-[12px] font-mono text-[var(--danger)] whitespace-pre-wrap break-words leading-tight overflow-x-auto max-h-48 custom-scrollbar">
            {detail}
          </pre>
        </div>
      )}

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
