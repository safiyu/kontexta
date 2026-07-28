"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Required for accessibility. Hidden visually when hideHeader is set. */
  title: string;
  description?: string;
  /** Tailwind max-width class for the panel. */
  widthClass?: string;
  /** Hide the standard header row (title still announced to screen readers). */
  hideHeader?: boolean;
  /** Tailwind positioning classes for the panel. Defaults to centered. */
  positionClass?: string;
  children: ReactNode;
}

const DEFAULT_POSITION_CLASS = "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2";

/**
 * The one modal scaffold. Focus trap, Escape, overlay click, focus restore,
 * and dialog semantics come from Radix. Styling comes from theme tokens.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  widthClass = "max-w-md",
  hideHeader = false,
  positionClass = DEFAULT_POSITION_CLASS,
  children,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-black/60 backdrop-blur-sm animate-fade-in" />
        <DialogPrimitive.Content
          className={`fixed ${positionClass} z-[var(--z-modal)] w-[92vw] ${widthClass} rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-2xl animate-scale-in focus:outline-none max-h-[85vh] flex flex-col`}
        >
          {hideHeader ? (
            <>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close
                className="btn btn-icon-sm absolute right-3 top-3 z-10"
                aria-label="Close"
              >
                <X className="w-4 h-4" aria-hidden />
              </DialogPrimitive.Close>
            </>
          ) : (
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--border)] shrink-0">
              <DialogPrimitive.Title className="text-sm font-bold text-[var(--text-primary)] font-title">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="btn btn-icon-sm" aria-label="Close">
                <X className="w-4 h-4" aria-hidden />
              </DialogPrimitive.Close>
            </div>
          )}
          {description ? (
            <DialogPrimitive.Description className="px-5 pt-3 text-xs text-[var(--text-secondary)]">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          <div className="p-5 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
