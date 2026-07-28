"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../ui/confirm-dialog";

interface Props {
  count: number;
  errorCount: number;
  onDiscard: () => void;
  onSave: () => void | Promise<void>;
  inline?: boolean;
}

export function SaveBar({ count, errorCount, onDiscard, onSave, inline }: Props) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, []);

  const hasChanges = count > 0 || status === "saved";
  const hidden = !inline && count === 0 && status !== "saved";
  const saveDisabled = errorCount > 0 || status !== "idle" || count === 0;
  
  const saveLabel = status === "saving"
    ? "Saving..."
    : status === "saved"
      ? "Saved ✓"
      : errorCount > 0
        ? `Fix ${errorCount} error(s)`
        : "Save Changes";

  const countLabel = status === "saved"
    ? "All changes saved"
    : count === 1
      ? "1 change"
      : `${count} changes`;

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

  const discardConfirmDialog = (
    <ConfirmDialog
      open={confirmingDiscard}
      onClose={handleCancelDiscard}
      onConfirm={handleConfirmDiscard}
      title="Discard unsaved changes?"
      message={
        count === 1
          ? "Your 1 unsaved change will be lost. This action cannot be undone."
          : `Your ${count} unsaved changes will be lost. This action cannot be undone.`
      }
      confirmLabel="Discard"
      destructive
    />
  );

  if (inline) {
    return (
      <div className="flex items-center gap-4">
        {hasChanges && (
          <div className="flex items-center gap-3 animate-fade-in">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20">
              <span className={`w-1.5 h-1.5 rounded-full bp-keep-round ${status === "saved" ? "bg-[var(--success)]" : "bg-[var(--accent)] animate-pulse"}`} />
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-primary)]">
                {countLabel}
              </span>
            </div>

            <button
              onClick={handleDiscardClick}
              disabled={status !== "idle" || count === 0}
              className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-secondary)] hover:text-[var(--danger)] transition-colors disabled:opacity-30"
            >
              Discard
            </button>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saveDisabled}
          className={`px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest rounded-lg transition-all ${
            saveDisabled
              ? "bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] cursor-not-allowed"
              : "bg-[var(--accent)] text-black shadow-lg shadow-[var(--accent)]/20 hover:scale-105 active:scale-95"
          }`}
        >
          {saveLabel}
        </button>

        {discardConfirmDialog}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={`sticky bottom-0 left-0 right-0 z-30 bg-[var(--bg-secondary)] border-t border-[var(--border)] shadow-[0_-4px_12px_rgba(0,0,0,0.08)] px-4 py-2 flex items-center gap-3 transition-transform duration-200 ${
        hidden ? "translate-y-full" : "translate-y-0"
      }`}
    >
      <span aria-hidden className={status === "saved" ? "text-[var(--success)]" : "text-[var(--accent)]"}>
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
        className="px-3 py-1 text-sm border border-[var(--border)] rounded text-[var(--success)] transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--success)]"
      >
        {saveLabel}
      </button>

      {discardConfirmDialog}
    </div>
  );
}
