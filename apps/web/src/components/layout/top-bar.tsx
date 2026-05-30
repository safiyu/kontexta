"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatedLogo } from "./animated-logo";
import { SyncPopover, type SyncLogEntry } from "@/components/sync/sync-popover";

interface TopBarProps {
  onSearch: () => void;
  onAbout: () => void;
  // Sync controls (lifted from former StatusBar)
  globalRemoteUrl: string | null;
  syncLog: SyncLogEntry[];
  onSyncAll: () => Promise<void>;
  onUpdateRemote: (url: string) => Promise<void>;
  selectedProjectName?: string | null;
  onSyncProject?: () => Promise<void>;
}

export function TopBar({
  onSearch,
  onAbout,
  globalRemoteUrl,
  syncLog,
  onSyncAll,
  onUpdateRemote,
  selectedProjectName,
  onSyncProject,
}: TopBarProps) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsMac(navigator.platform.toUpperCase().indexOf("MAC") >= 0);
  }, []);

  const modifier = isMac ? "⌘" : "Ctrl";

  return (
    <header className="h-16 bg-[#FFFDF7] dark:bg-gradient-to-r dark:from-[var(--bg-secondary)] dark:via-[var(--bg-tertiary)] dark:to-[var(--bg-secondary)] flex items-center px-4 border-b border-[var(--border)] gap-3 overflow-visible">
      <div className="flex items-center gap-0.5">
        <AnimatedLogo size="sm" />
        <span
          className="font-extrabold text-xl tracking-[4px] text-[#D4903A] drop-shadow-[0_0_14px_rgba(212,144,58,0.55)]"
        >
          KONTEXTA
        </span>
      </div>

      <div className="flex-1 flex justify-center px-4">
        <button
          onClick={onSearch}
          className="w-full max-w-[400px] h-9 px-4 bg-[var(--bg-tertiary)] text-[13px] text-[#5C3D24] dark:text-[#F5C97A] rounded-lg hover:bg-[var(--bg-secondary)] transition-all flex items-center gap-3 border border-[var(--border)] hover:border-[var(--accent)]/50 group shadow-sm"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span className="flex-1 text-left">Search anything in your context...</span>
          <kbd className="text-[10px] font-mono text-[#5C3D24] dark:text-[#F5C97A] bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded border border-[var(--border)]">{modifier}K</kbd>
        </button>
      </div>

      <div className="flex items-center gap-2">
        {mounted && (
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="relative w-8 h-4 bg-[var(--accent)] border border-black/10 rounded-full flex items-center justify-between px-1 text-[8px]"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            <span aria-hidden className={`transition-opacity ${theme === "dark" ? "opacity-60" : "opacity-100"} text-white text-[9px] leading-none`}>☀</span>
            <span aria-hidden className={`transition-opacity ${theme === "light" ? "opacity-60" : "opacity-100"} text-black text-[9px] leading-none`}>☽</span>
            <span
              aria-hidden
              className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white border border-black/10 rounded-full shadow transition-transform ${theme === "dark" ? "translate-x-4" : ""}`}
            />
          </button>
        )}

        <button
          onClick={() => setSyncOpen((o) => !o)}
          className="btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--accent)]"
          aria-label="Sync menu"
          title="Open sync menu"
        >
          Sync ▾
        </button>

        <button
          onClick={() => router.push("/docs")}
          className="btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--accent)]"
          aria-label="Configure Kontexta"
        >
          Configure
        </button>

        <button
          onClick={onAbout}
          className="btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--accent)]"
          aria-label="About Kontexta"
        >
          About
        </button>
      </div>

      <SyncPopover
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        log={syncLog}
        globalRemoteUrl={globalRemoteUrl}
        onSyncAll={onSyncAll}
        onUpdateRemote={onUpdateRemote}
        selectedProjectName={selectedProjectName ?? null}
        onSyncProject={onSyncProject}
      />
    </header>
  );
}
