"use client";

import type { ReactNode } from "react";
import { Dialog } from "./dialog";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="text-sm text-[var(--text-secondary)]">{message}</div>
      <div className="flex justify-end gap-2 mt-5">
        <button type="button" className="btn btn-md" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn btn-md ${destructive ? "btn-destructive" : "btn-primary"}`}
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? "…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
