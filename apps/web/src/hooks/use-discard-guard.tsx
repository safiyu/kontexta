"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

// Async replacement for window.confirm: returns false and shows an in-app dialog when dirty; Discard re-runs the blocked action.
export function useDiscardGuard(): {
  confirmDiscardIfDirty: (retry: () => void) => boolean;
  setDirty: (key: string, dirty: boolean) => void;
  dialog: ReactNode;
} {
  // Each editor reports under its own key, so several can be dirty independently.
  const dirtyRef = useRef(new Set<string>());
  const [pending, setPending] = useState<(() => void) | null>(null);

  const setDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) dirtyRef.current.add(key);
    else dirtyRef.current.delete(key);
  }, []);

  const confirmDiscardIfDirty = useCallback((retry: () => void): boolean => {
    if (dirtyRef.current.size === 0) return true;
    setPending(() => retry);
    return false;
  }, []);

  // Catches tab close / hard-refresh while editing.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current.size > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      onConfirm={() => {
        const retry = pending;
        dirtyRef.current.clear();
        setPending(null);
        retry?.();
      }}
      title="Unsaved changes"
      message="You have unsaved changes in the open file. Discard them?"
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      destructive
    />
  );

  return { confirmDiscardIfDirty, setDirty, dialog };
}
