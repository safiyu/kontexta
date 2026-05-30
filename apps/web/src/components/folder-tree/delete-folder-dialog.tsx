"use client";

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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
      <div className="w-[400px] bg-[var(--bg-primary)] border border-red-500/20 rounded-lg shadow-2xl overflow-hidden animate-fade-in">
        <div className="p-6">
          <div className="flex items-center gap-3 text-red-500 mb-4">
            <span className="text-2xl">⚠️</span>
            <h3 className="text-lg font-bold">DELETE FOLDER</h3>
          </div>

          <p className="text-sm text-[var(--text-secondary)] mb-6">
            Are you sure you want to delete the folder <span className="font-bold text-[var(--text-primary)]">"{folderName}"</span>?
            This will permanently remove the directory from your disk.
          </p>

          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              disabled={loading}
              className="btn btn-md"
            >
              CANCEL
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className="btn btn-md btn-destructive"
            >
              {loading ? "DELETING..." : "DELETE FOLDER"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
