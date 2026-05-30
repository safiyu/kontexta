"use client";

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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
      <div className="w-[400px] bg-[var(--bg-primary)] border border-red-500/20 rounded-lg shadow-2xl overflow-hidden animate-fade-in">
        <div className="p-6">
          <div className="flex items-center gap-3 text-red-500 mb-4">
            <span className="text-2xl">⚠️</span>
            <h3 className="text-lg font-bold">DELETE FILE</h3>
          </div>

          <p className="text-sm text-[var(--text-secondary)] mb-6">
            Are you sure you want to delete <span className="font-bold text-[var(--text-primary)]">"{title}"</span>?
            This action cannot be undone.
          </p>

          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-xs font-bold text-gray-500 hover:text-[var(--text-primary)] transition-colors"
            >
              CANCEL
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className="px-6 py-2 bg-red-600 text-white text-xs font-bold rounded hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {loading ? "DELETING..." : "DELETE PERMANENTLY"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
