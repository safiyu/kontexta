"use client";

import { ConfirmDialog } from "../ui/confirm-dialog";

interface DeleteFolderDialogProps {
  open: boolean;
  folderName: string;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}

export function DeleteFolderDialog({
  open,
  folderName,
  onClose,
  onConfirm,
  loading,
}: DeleteFolderDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Delete folder"
      message={
        <>
          Are you sure you want to delete the folder{" "}
          <span className="font-bold text-[var(--text-primary)]">&quot;{folderName}&quot;</span>? This will
          permanently remove the directory from your disk.
        </>
      }
      confirmLabel="Delete folder"
      destructive
      loading={loading}
    />
  );
}
