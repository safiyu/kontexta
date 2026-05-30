"use client";

import { useEffect, useState } from "react";
import type { SyncStatus } from "@/hooks/use-sync-status";

interface StatusBarProps {
  globalRemoteUrl: string | null;
  status: SyncStatus;
  lastDoneAt: number | null;
  stage: string | null;
}

function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function StatusBar({ globalRemoteUrl, status, lastDoneAt, stage }: StatusBarProps) {
  // Tick every 30s so "synced 2m ago" stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const dotColor =
    status === "ok" ? "var(--success)"
    : status === "syncing" ? "var(--warning)"
    : status === "error" ? "var(--danger)"
    : "var(--text-secondary)";

  const label =
    status === "syncing" ? "syncing..."
    : status === "error" ? "sync failed"
    : status === "no-remote" ? "no remote configured"
    : status === "ok" ? `synced ${formatRelative(lastDoneAt)}`
    : lastDoneAt ? `synced ${formatRelative(lastDoneAt)}` : "ready";

  const remoteLabel = globalRemoteUrl
    ? globalRemoteUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "")
    : null;

  return (
    <footer className="relative h-7 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 flex items-center gap-2.5 text-[13px] text-[var(--text-secondary)] font-mono">
      <span style={{ color: dotColor }} className={status === "syncing" ? "animate-pulse" : ""}>
        ●
      </span>
      <span>{label}</span>
      <span className="text-[var(--border)]">·</span>
      <span className={`font-medium ${status === "syncing" ? "text-[var(--warning)]" : ""}`}>
        git: {status === "syncing" ? (stage || "working") : "clean"}
      </span>
      {remoteLabel && (
        <>
          <span className="text-[var(--border)]">·</span>
          <span className="truncate max-w-[260px] opacity-70">{remoteLabel}</span>
        </>
      )}
    </footer>
  );
}
