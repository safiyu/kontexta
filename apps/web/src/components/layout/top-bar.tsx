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
  onViewPublished: () => void;
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
  onViewPublished,
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
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  // null = no toast, otherwise the success/error line shown briefly below.
  const [reindexToast, setReindexToast] = useState<string | null>(null);

  const handleReindex = async () => {
    if (reindexing) return;
    setReindexing(true);
    setReindexToast(null);
    try {
      const res = await fetch("/api/reindex", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.success) {
        const t = body.totals ?? { newly_indexed: 0, refreshed: 0, pruned: 0, errors: 0 };
        setReindexToast(
          `Reindexed ${body.scopes?.length ?? 0} scope(s) in ${body.duration_ms ?? "?"}ms — ` +
          `+${t.newly_indexed} new, ${t.refreshed} updated, ${t.pruned} removed` +
          (t.errors ? `, ${t.errors} scope error(s)` : ""),
        );
      } else if (res.status === 409) {
        setReindexToast("Reindex already in progress");
      } else {
        setReindexToast(`Reindex failed: ${body?.error ?? `HTTP ${res.status}`}`);
      }
    } catch (e: any) {
      setReindexToast(`Reindex failed: ${e?.message ?? "Network error"}`);
    } finally {
      setReindexing(false);
      // Auto-clear after 8s so the toast doesn't sit forever.
      setTimeout(() => setReindexToast(null), 8000);
    }
  };

  useEffect(() => {
    setMounted(true);
    setIsMac(navigator.platform.toUpperCase().indexOf("MAC") >= 0);
  }, []);

  useEffect(() => {
    const close = () => setPublishMenuOpen(false);
    if (publishMenuOpen) {
      window.addEventListener("click", close);
      return () => window.removeEventListener("click", close);
    }
  }, [publishMenuOpen]);

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
        <button
          onClick={() => setSyncOpen((o) => !o)}
          className="btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--accent)]"
          aria-label="Sync menu"
          title="Open sync menu"
        >
          Sync ▾
        </button>

        <button
          onClick={handleReindex}
          disabled={reindexing}
          className={`btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--accent)] ${reindexing ? "opacity-50" : ""}`}
          aria-label="Reindex — scan disk to add new files and remove orphan rows"
          title="Reindex Knowledge Base + all projects: add new files and drop orphan rows"
        >
          {reindexing ? "Reindexing…" : "Reindex"}
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

        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPublishMenuOpen((o) => !o);
            }}
            className="btn btn-md !font-mono font-bold uppercase tracking-wider text-[var(--accent)]"
            aria-label="Publish menu"
            title="Publish documentation"
          >
            Publish ▾
          </button>
          {publishMenuOpen && (
            <div className="absolute right-0 top-full mt-2 w-48 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-xl overflow-hidden z-[100]">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPublishMenuOpen(false);
                  onPublish();
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4 text-[#B4781E]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4h16v16H4z" />
                  <path d="M12 8v8M8 12h8" />
                </svg>
                New Publish
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPublishMenuOpen(false);
                  onViewPublished();
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2 border-t border-[var(--border)]"
              >
                <svg className="w-4 h-4 text-[#B4781E]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                View Published
              </button>
            </div>
          )}
        </div>

        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            // Use router.push so React unmounts the WS hook cleanly before
            // navigating — prevents a spurious 1008 WS reconnect error.
            router.push("/login");
          }}
          className="p-2 rounded-md text-[var(--text-secondary)] hover:text-red-400 hover:bg-[var(--bg-tertiary)] transition-colors"
          aria-label="Lock Kontexta"
          title="Lock Kontexta"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </button>

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
      {reindexToast && (
        <div
          role="status"
          className="fixed top-20 right-6 z-[100] max-w-md px-4 py-3 rounded-lg shadow-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm text-[var(--text-primary)]"
        >
          {reindexToast}
        </div>
      )}
    </header>
  );
}
