"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  count: number;
  errorCount: number;
  onDiscard: () => void;
  onSave: () => void | Promise<void>;
}

export function SaveBar({ count, errorCount, onDiscard, onSave }: Props) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, []);

  // Bar visible if there are unsaved changes OR we're showing the post-save confirmation.
  const hidden = count === 0 && status !== "saved";
  const saveDisabled = errorCount > 0 || status !== "idle" || count === 0;
  const saveLabel = status === "saving"
    ? "Saving…"
    : status === "saved"
      ? "Saved ✓"
      : saveDisabled
        ? `Fix ${errorCount} error(s)`
        : "Save";
  const countLabel = status === "saved"
    ? "All changes saved"
    : count === 1
      ? "1 unsaved change"
      : `${count} unsaved changes`;

  const handleSave = async () => {
    if (saveDisabled) return;
    setStatus("saving");
    try {
      await onSave();
      setStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("idle");
    }
  };

  const handleDiscardClick = () => setConfirmingDiscard(true);
  const handleConfirmDiscard = () => {
    setConfirmingDiscard(false);
    onDiscard();
  };
  const handleCancelDiscard = () => setConfirmingDiscard(false);

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={`sticky bottom-0 left-0 right-0 z-30 bg-[var(--bg-secondary)] border-t border-[var(--border)] shadow-[0_-4px_12px_rgba(0,0,0,0.08)] px-4 py-2 flex items-center gap-3 transition-transform duration-200 ${
        hidden ? "translate-y-full" : "translate-y-0"
      }`}
    >
      <span aria-hidden className={status === "saved" ? "text-green-500" : "text-[var(--accent)]"}>
        {status === "saved" ? "✓" : "⚠"}
      </span>
      <span className="text-sm" aria-live="polite">{countLabel}</span>
      <div className="flex-1" />
      <button
        onClick={handleDiscardClick}
        disabled={status !== "idle" || count === 0}
        className="px-3 py-1 text-sm border border-[var(--border)] rounded hover:bg-[var(--accent)] hover:text-black transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Discard
      </button>
      <button
        onClick={handleSave}
        disabled={saveDisabled}
        className="px-3 py-1 text-sm border border-[var(--border)] rounded text-green-500 transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-green-500"
      >
        {saveLabel}
      </button>

      {confirmingDiscard && typeof document !== "undefined" && createPortal(
        <div
          role="dialog"
          aria-label="Confirm discard"
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={(e) => e.target === e.currentTarget && handleCancelDiscard()}
        >
          <div className="w-[420px] bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg p-5 shadow-2xl space-y-4">
            <h2 className="text-lg font-semibold">Discard unsaved changes?</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {count === 1
                ? "Your 1 unsaved change will be lost."
                : `Your ${count} unsaved changes will be lost.`}
              {" "}This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <button
                onClick={handleCancelDiscard}
                className="px-3 py-1 text-sm border border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDiscard}
                className="px-3 py-1 text-sm border border-red-500 rounded text-red-500 transition hover:bg-red-500 hover:text-white focus:bg-red-500 focus:text-white"
              >
                Discard
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
