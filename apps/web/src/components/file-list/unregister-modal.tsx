"use client";

import { ConfirmDialog } from "../ui/confirm-dialog";

interface UnregisterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  projectName: string;
}

export function UnregisterModal({
  isOpen,
  onClose,
  onConfirm,
  projectName,
}: UnregisterModalProps) {
  return (
    <ConfirmDialog
      open={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Unregister project"
      message={
        <>
          Are you sure you want to remove <span className="font-bold text-[var(--text-primary)]">&quot;{projectName}&quot;</span> from
          Kontexta?
          <br />
          <br />
          This will remove all associated context files from your AI&apos;s memory, but your{" "}
          <span className="text-amber-accent font-bold">actual source code will remain safe</span> on your disk.
          <br />
          <br />
          <span className="text-[10px] uppercase tracking-widest font-bold">
            This action is permanent for Kontexta metadata.
          </span>
        </>
      }
      confirmLabel="Unregister"
      destructive
    />
  );
}
