"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useAgents } from "@/hooks/use-agents";

const DISMISS_KEY = "hooksBannerDismissed";

export function HooksBanner({ onOpen }: { onOpen: () => void }) {
  const { state } = useAgents();
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);

  useEffect(() => { setDismissedSig(sessionStorage.getItem(DISMISS_KEY)); }, []);

  const alerts = state?.alerts ?? [];
  const signature = alerts.map((a) => a.agent).sort().join(",");
  if (alerts.length === 0 || dismissedSig === signature) return null;

  const missing = alerts.filter((a) => !a.installed).map((a) => a.name);
  const silent = alerts.filter((a) => a.installed).map((a) => a.name);
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Hooks not installed for ${missing.join(", ")}`);
  if (silent.length > 0) parts.push(`No events yet from ${silent.join(", ")}`);

  return (
    <div role="alert" aria-label={parts.join(". ")} className="mx-4 mt-2 flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--accent-soft)] px-4 py-2 text-[var(--text-primary)]">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
      <p className="flex-1 text-sm">{parts.join(". ")}.</p>
      <button className="btn btn-sm btn-outline" onClick={onOpen}>Set up hooks</button>
      <button
        className="btn btn-icon-sm"
        aria-label="Dismiss"
        onClick={() => { sessionStorage.setItem(DISMISS_KEY, signature); setDismissedSig(signature); }}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
