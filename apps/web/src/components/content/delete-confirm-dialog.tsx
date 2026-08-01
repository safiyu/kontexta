"use client";

import { ConfirmDialog } from "../ui/confirm-dialog";

interface DeleteConfirmDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}

export function DeleteConfirmDialog({
  open,
  title,
  onClose,
  onConfirm,
  loading,
}: DeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Delete file"
      message={
        <>
          Delete &quot;<span className="font-bold text-[var(--text-primary)]">{title}</span>&quot;? Knowledge
          Base files are recoverable from git history (Time Travel). Project files are only removed from the
          index — the file on disk is untouched.
        </>
      }
      confirmLabel="Delete"
      destructive
      loading={loading}
    />
  );
}
