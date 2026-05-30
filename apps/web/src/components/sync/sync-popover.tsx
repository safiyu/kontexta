"use client";

import { useState } from "react";

export interface SyncLogEntry {
  projectId: number | null;
  result: "ok" | "error";
  at: number;
  message?: string;
}

interface SyncPopoverProps {
  open: boolean;
  onClose: () => void;
  log: SyncLogEntry[];
  globalRemoteUrl: string | null;
  onSyncAll: () => Promise<void>;
  onUpdateRemote: (url: string) => Promise<void>;
  /** When provided, shows a "Sync <ProjectName>" action above "Sync all". */
  selectedProjectName?: string | null;
  onSyncProject?: () => Promise<void>;
}

export function SyncPopover({
  open,
  onClose,
  log,
  globalRemoteUrl,
  onSyncAll,
  onUpdateRemote,
  selectedProjectName,
  onSyncProject,
}: SyncPopoverProps) {
  const [view, setView] = useState<"log" | "config">("log");
  const [urlInput, setUrlInput] = useState(globalRemoteUrl || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const handleSyncAll = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSyncAll();
    } catch (e: any) {
      setErr(e?.message || "Sync failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveRemote = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onUpdateRemote(urlInput);
      setView("log");
    } catch (e: any) {
      setErr(e?.message || "Failed to save remote");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* outside-click backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="dialog"
        className="fixed top-14 right-3 z-50 w-80 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md shadow-xl text-[13px] text-[var(--text-primary)]"
      >
        <div className="flex border-b border-[var(--border)]">
          <button
            className={`flex-1 px-3 py-2 ${view === "log" ? "text-[var(--accent)] border-b-2 border-[var(--accent)] -mb-px" : "text-[var(--text-secondary)]"}`}
            onClick={() => setView("log")}
          >
            Sync log
          </button>
          <button
            className={`flex-1 px-3 py-2 ${view === "config" ? "text-[var(--accent)] border-b-2 border-[var(--accent)] -mb-px" : "text-[var(--text-secondary)]"}`}
            onClick={() => setView("config")}
          >
            Configure remote
          </button>
        </div>

        {view === "log" ? (
          <div className="p-3 space-y-2 max-h-72 overflow-auto">
            {log.length === 0 ? (
              <p className="text-[var(--text-secondary)] text-[12px]">No sync activity yet.</p>
            ) : (
              log.slice(0, 5).map((e, i) => (
                <div key={i} className="flex items-baseline gap-2 font-mono text-[12px]">
                  <span style={{ color: e.result === "ok" ? "var(--success)" : "var(--danger)" }}>●</span>
                  <span className="text-[var(--text-secondary)]">{new Date(e.at).toLocaleTimeString()}</span>
                  <span className="text-[var(--text-primary)] truncate">
                    {e.projectId === null ? "all projects" : `project #${e.projectId}`}
                    {e.message ? ` — ${e.message}` : ""}
                  </span>
                </div>
              ))
            )}
            {selectedProjectName && onSyncProject && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await onSyncProject();
                  } catch (e: any) {
                    setErr(e?.message || "Sync failed");
                  } finally {
                    setBusy(false);
                  }
                }}
                className="w-full mt-2 px-3 py-1.5 bg-[var(--accent)] text-black font-bold text-[12px] rounded-md disabled:opacity-50 truncate"
              >
                {busy ? "Syncing..." : `Sync ${selectedProjectName}`}
              </button>
            )}
            <button
              disabled={busy}
              onClick={handleSyncAll}
              className="w-full mt-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-bold text-[12px] rounded-md hover:bg-[var(--border)] disabled:opacity-50"
            >
              {busy ? "Syncing..." : "Sync all projects"}
            </button>
            {err && <p className="text-[var(--danger)] text-[12px]">{err}</p>}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            <label className="block text-[12px] text-[var(--text-secondary)]">Global git remote URL</label>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://github.com/user/repo.git or git@host:user/repo.git"
              className="w-full px-2 py-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-[12px]"
            />
            <button
              disabled={busy}
              onClick={handleSaveRemote}
              className="w-full px-3 py-1.5 bg-[var(--accent)] text-black font-bold text-[12px] rounded-md disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save"}
            </button>
            {err && <p className="text-[var(--danger)] text-[12px]">{err}</p>}
          </div>
        )}
      </div>
    </>
  );
}
