"use client";

import { AlertTriangle } from "lucide-react";

interface ProfileBannerProps {
  showProfile: boolean;
  showOnboard: boolean;
  onResume: () => void;
}

export function ProfileBanner({ showProfile, showOnboard, onResume }: ProfileBannerProps) {
  if (!showProfile && !showOnboard) return null;

  const messages: string[] = [];
  if (showProfile) messages.push("Set up your profile");
  if (showOnboard) messages.push("Onboard an agent");

  return (
    <div
      role="alert"
      aria-label={`Setup incomplete: ${messages.join(" and ")}`}
      className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--accent-soft)] px-4 py-3 text-[var(--text-primary)]"
    >
      <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
      <p className="flex-1 text-sm">
        Setup incomplete: {messages.join(" and ")}.
      </p>
      <button
        onClick={onResume}
        className="shrink-0 rounded-md bg-[var(--accent)]/20 px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)]/30"
      >
        Resume setup
      </button>
    </div>
  );
}
