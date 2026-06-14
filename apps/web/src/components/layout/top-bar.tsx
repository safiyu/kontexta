"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatedLogo } from "./animated-logo";
import { SyncPopover, type SyncLogEntry } from "@/components/sync/sync-popover";

interface TopBarProps {
  onSearch: () => void;
  onAbout: () => void;
  onConfigure: () => void;
  onPublish: () => void;
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
  onConfigure,
  onPublish,
  globalRemoteUrl,
  syncLog,
  onSyncAll,
  onUpdateRemote,
  selectedProjectName,
  onSyncProject,
}: TopBarProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsMac(navigator.platform.toUpperCase().indexOf("MAC") >= 0);
  }, []);

  const modifier = isMac ? "⌘" : "Ctrl";

  return (
    <header className="sticky top-0 z-50 h-16 bg-[var(--bg-secondary)]/80 backdrop-blur-xl flex items-center px-6 border-b border-[var(--border)] gap-3 overflow-visible transition-all">
      <div className="flex items-center gap-0 group cursor-pointer" onClick={() => router.push("/")}>
        <AnimatedLogo size="sm" />
        <span
          className="-ml-3 font-extrabold text-xl tracking-[4px] font-title text-[#0F274F] dark:text-white drop-shadow-[0_0_15px_rgba(180,120,30,0.1)] dark:drop-shadow-[0_0_15px_rgba(180,120,30,0.3)] transition-all group-hover:drop-shadow-[0_0_20px_rgba(180,120,30,0.5)]"
        >
          ONTEXTA
        </span>
      </div>

      <div className="flex-1 flex justify-center px-4">
        <button
          onClick={onSearch}
          className="w-full max-w-[440px] h-10 px-4 bg-[var(--bg-tertiary)]/50 text-[13px] text-[#5C3D24] dark:text-[#F5C97A] rounded-xl hover:bg-[var(--bg-secondary)] transition-all flex items-center gap-3 border border-[var(--border)] group focus-glow"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span className="flex-1 text-left opacity-60 group-hover:opacity-100">Search anything in your context...</span>
          <kbd className="text-[10px] font-mono text-[#5C3D24] dark:text-[#F5C97A] bg-[var(--bg-secondary)] px-2 py-1 rounded-md border border-[var(--border)] shadow-sm opacity-50">{modifier}K</kbd>
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
          onClick={onConfigure}
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

        <button
          onClick={onPublish}
          className="btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--accent)]"
          aria-label="Publish documentation"
          title="Publish documentation site"
        >
          Publish
        </button>

        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            // Use router.push so React unmounts the WS hook cleanly before
            // navigating — prevents a spurious 1008 WS reconnect error.
            router.push("/login");
          }}
          className="btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--text-secondary)] hover:text-red-400"
          aria-label="Lock Kontexta"
        >
          Lock
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
