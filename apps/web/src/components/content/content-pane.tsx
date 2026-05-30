"use client";

import { useState, useEffect, useRef } from "react";
import { MarkdownViewer } from "./markdown-viewer";
import { MermaidViewer } from "./mermaid-viewer";
import { MarkdownEditor } from "./markdown-editor";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { GitErrorDialog } from "./git-error-dialog";

const TrashIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

interface File {
  id: number;
  project_id: number | null;
  title: string;
  content: string;
  path: string;
  storage_type: "db" | "git";
  tags: string[];
  favorite: boolean;
  folder: string | null;
  created_at: string;
  updated_at: string;
  git_warning?: string;
}

const StarIcon = ({ filled, className }: { filled: boolean; className?: string }) => (
  <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

interface ContentPaneProps {
  fileId: number | null;
  onDelete: (id: number) => Promise<void>;
  // Notify parent after favorite/tag mutations so views derived from the
  // global file list (e.g. the Favorites section) see fresh state instead
  // of waiting for an unrelated watcher event.
  onChanged?: () => void;
  // Lets the parent guard navigation handlers against discarding
  // in-progress edits (window.confirm before clearing selectedFileId).
  onDirtyChange?: (dirty: boolean) => void;
}

export function ContentPane({ fileId, onDelete, onChanged, onDirtyChange }: ContentPaneProps) {
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [viewHistory, setViewHistory] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [fetchingHistory, setFetchingHistory] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [gitErrorOpen, setGitErrorOpen] = useState(false);
  const [gitErrorMessage, setGitErrorMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!fileId) return;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/files/${fileId}`);
      if (response.ok) {
        const data = await response.json();
        setFile(data);
        setEditContent(data.content);
      }
    } catch (error) {
      console.error("Failed to refresh file:", error);
    } finally {
      setRefreshing(false);
    }
  };

  // Mirrors the fileId PROP (not the loaded file?.id) so async handlers
  // detect navigation as soon as it happens, not after the new file's
  // GET resolves. Using file?.id leaves a window between click-on-B and
  // B's fetch landing where the ref still points at A — during which a
  // stale handler for A can sneak its result through the equality check.
  const fileIdRef = useRef<number | null>(fileId);
  useEffect(() => { fileIdRef.current = fileId; }, [fileId]);

  // Bubble dirty state up so the parent can confirm before navigation.
  useEffect(() => {
    const dirty = editing && file != null && editContent !== file.content;
    onDirtyChange?.(dirty);
  }, [editing, editContent, file?.content, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  useEffect(() => {
    if (fileId === null) {
      setFile(null);
      setEditing(false);
      setViewHistory(false);
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/files/${fileId}`);
        if (response.ok) {
          const data = await response.json();
          setFile(data);
          setEditContent(data.content);
        }
      } catch (error) {
        console.error("Failed to fetch file:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
    setViewHistory(false);
  }, [fileId]);

  const fetchHistory = async () => {
    if (!fileId) return;
    setFetchingHistory(true);
    try {
      const response = await fetch(`/api/files/${fileId}/history`);
      if (response.ok) {
        const data = await response.json();
        setHistory(data);
      }
    } catch (error) {
      console.error("Failed to fetch history:", error);
    } finally {
      setFetchingHistory(false);
    }
  };

  const handleRestore = async (hash: string) => {
    if (!fileId) return;
    try {
      const response = await fetch(`/api/files/${fileId}/history/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash }),
      });
      if (response.ok) {
        const data = await response.json();
        setFile((prev) => prev ? { ...prev, content: data.content } : null);
        setEditContent(data.content);
        setViewHistory(false);
      }
    } catch (error) {
      console.error("Failed to restore version:", error);
    }
  };

  const handleEdit = () => {
    setEditing(true);
    setEditContent(file?.content || "");
  };

  const handleCancel = () => {
    setEditing(false);
    setEditContent(file?.content || "");
  };

  const handleSave = async () => {
    if (!file) return;
    // Capture the id at handler entry — if the user navigates to a
    // different file mid-save, the response from the OLD file's PUT must
    // not clobber the NEW file's content state.
    const savingFileId = file.id;

    try {
      setSaving(true);
      const response = await fetch(`/api/files/${savingFileId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: editContent,
          // Optimistic-concurrency precondition. Server 409s if the row
          // was touched (by another tab or a watcher event) since we
          // loaded it; the catch block below pulls the fresh content so
          // the user can decide what to keep instead of silently clobbering.
          expected_updated_at: file.updated_at,
        }),
      });

      if (response.ok) {
        const updatedFile = await response.json();
        if (fileIdRef.current !== savingFileId) {
          if (updatedFile.git_warning) {
            console.warn(`[kontexta] git_warning for stale file ${savingFileId}:`, updatedFile.git_warning);
          }
          return;
        }
        setFile(updatedFile);
        setEditing(false);
        if (updatedFile.git_warning) {
          setGitErrorMessage(updatedFile.git_warning);
          setGitErrorOpen(true);
        }
      } else if (response.status === 409) {
        // Conflict: refresh the underlying file so the user sees the
        // newer disk content and decides whether to overwrite. Their
        // unsaved edits stay in editContent.
        let serverContent: string | undefined;
        let serverUpdatedAt: string | undefined;
        try {
          const data = await response.json();
          serverContent = data?.current?.content;
          serverUpdatedAt = data?.current?.updated_at;
        } catch {}
        if (fileIdRef.current === savingFileId) {
          if (serverContent !== undefined && serverUpdatedAt !== undefined) {
            setFile((prev) => prev ? { ...prev, content: serverContent!, updated_at: serverUpdatedAt! } : prev);
          }
          setGitErrorMessage(
            "This file was modified elsewhere since you opened it. Disk content has been reloaded; click Save again to overwrite with your edits."
          );
          setGitErrorOpen(true);
        }
      } else {
        let msg = `Save failed (${response.status})`;
        try { const data = await response.json(); if (data?.error) msg = data.error; } catch {}
        if (fileIdRef.current === savingFileId) {
          setGitErrorMessage(msg);
          setGitErrorOpen(true);
        }
      }
    } catch (error: any) {
      console.error("Failed to save file:", error);
      if (fileIdRef.current === savingFileId) {
        setGitErrorMessage(error?.message ?? "Network error while saving");
        setGitErrorOpen(true);
      }
    } finally {
      if (fileIdRef.current === savingFileId) setSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!file) return;
    setDeleting(true);
    try {
      await onDelete(file.id);
      setFile(null);
      setDeleteDialogOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  if (!fileId) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[#475569] dark:text-[#94A3B8] gap-3 animate-fade-in">
        <span className="text-6xl opacity-40 dark-icon">📂</span>
        <div className="text-center">
          <p className="text-lg font-bold text-[#0F172A] dark:text-[#F1F5F9]">Select a file to preview</p>
          <p className="text-sm font-medium text-[#475569] dark:text-[#94A3B8] mt-2">Choose a file from the list on the left</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex flex-col animate-fade-in">
        <div className="border-b border-[var(--border)] px-6 py-4">
          <div className="skeleton h-6 w-48 mb-2" />
          <div className="skeleton h-4 w-32" />
        </div>
        <div className="flex-1 p-6 space-y-4">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-5/6" />
          <div className="skeleton h-4 w-4/6" />
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-3/4" />
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[#475569] dark:text-[#94A3B8] gap-3 animate-fade-in">
        <span className="text-6xl opacity-40 dark-icon">🔍</span>
        <div className="text-center">
          <p className="text-lg font-bold text-[#0F172A] dark:text-[#F1F5F9]">File not found</p>
          <p className="text-sm font-medium text-[#475569] dark:text-[#94A3B8] mt-2">This file may have been moved or deleted</p>
        </div>
      </div>
    );
  }

  return (
    <div key={fileId} className="h-full flex flex-col animate-fade-in">
      <div className="h-10 px-4 border-b border-[var(--border)] flex items-center gap-4 text-[14px] sticky top-0 bg-[var(--bg-primary)] z-10">
        {(["view", "edit", "history"] as const).map((mode) => {
          const active =
            (mode === "view" && !editing && !viewHistory) ||
            (mode === "edit" && editing) ||
            (mode === "history" && viewHistory);
          const onTabClick = () => {
            if (mode === "edit") {
              if (!editing) handleEdit();
              return;
            }
            // Switching away from edit cancels in-progress edits.
            if (editing) handleCancel();
            setViewHistory(mode === "history");
            if (mode === "history") fetchHistory();
          };
          return (
            <button
              key={mode}
              onClick={onTabClick}
              className={`btn btn-sm -mb-px py-2 border-b-2 transition-colors ${
                active ? "border-[var(--accent)]" : ""
              }`}
            >
              {mode[0].toUpperCase() + mode.slice(1)}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-3 text-[12px] text-[var(--text-secondary)] font-mono">
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn btn-md"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleCancel}
                disabled={saving}
                className="btn btn-md"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {file?.updated_at && <span>edited {formatRelative(file.updated_at)}</span>}
              {file?.content && (
                <>
                  <span className="text-[var(--border)]">·</span>
                  <span title={`~${Math.max(1, Math.ceil(file.content.length / 4)).toLocaleString()} tokens (heuristic: chars/4)`}>
                    ~{formatTokens(Math.max(1, Math.ceil(file.content.length / 4)))} tok
                  </span>
                </>
              )}
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="btn btn-md"
                aria-label="Refresh file"
                title="Refresh file content"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 opacity-70 ${refreshing ? "animate-spin" : ""}`}>
                  <path d="M21 2v6h-6"></path>
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
                  <path d="M3 22v-6h6"></path>
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
                </svg>
              </button>
              <button
                onClick={async () => {
                  if (!file) return;
                  const next = !file.favorite;
                  // Optimistic update.
                  setFile({ ...file, favorite: next });
                  try {
                    const res = await fetch(`/api/files/${file.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ favorite: next }),
                    });
                    if (!res.ok) throw new Error("PATCH failed");
                    onChanged?.();
                  } catch (e) {
                    // Roll back optimistic toggle.
                    setFile({ ...file, favorite: !next });
                    console.error("Failed to toggle favorite:", e);
                  }
                }}
                className="btn btn-md"
                aria-label={file?.favorite ? "Unfavorite" : "Favorite"}
                title={file?.favorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  filled={!!file?.favorite}
                  className={`w-4 h-4 ${file?.favorite ? "text-amber-accent" : "opacity-60"}`}
                />
              </button>
              <button
                onClick={() => setDeleteDialogOpen(true)}
                className="btn btn-md btn-destructive"
                aria-label="Delete file"
                title="Delete file"
              >
                <TrashIcon className="w-4 h-4 opacity-70" />
                <span className="font-bold uppercase tracking-tighter text-[11px]">Delete</span>
              </button>
            </>
          )}
        </div>
      </div>

      {!editing && !viewHistory && (
        <div className="px-4 py-2 border-b border-[var(--border)] flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-[var(--text-secondary)] uppercase tracking-wider text-[10px] font-bold">Tags</span>
          {(file?.tags ?? []).map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-accent/10 border border-amber-accent/30 text-[var(--text-primary)]"
            >
              {t}
              <button
                aria-label={`Remove tag ${t}`}
                title={`Remove tag ${t}`}
                onClick={async () => {
                  if (!file) return;
                  const next = file.tags.filter((x) => x !== t);
                  setFile({ ...file, tags: next });
                  try {
                    const res = await fetch(`/api/files/${file.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tags: next }),
                    });
                    if (!res.ok) throw new Error("PATCH failed");
                    onChanged?.();
                  } catch (e) {
                    setFile({ ...file, tags: file.tags });
                    console.error("Failed to remove tag:", e);
                  }
                }}
                className="text-[var(--text-secondary)] hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            placeholder="add tag…"
            className="bg-transparent border-b border-transparent focus:border-amber-accent/40 outline-none px-1 py-0.5 w-24"
            onKeyDown={async (e) => {
              if (e.key !== "Enter" || !file) return;
              const raw = (e.currentTarget.value || "").trim();
              if (!raw) return;
              const tag = raw.toLowerCase().replace(/\s+/g, "-");
              if (file.tags.includes(tag)) {
                e.currentTarget.value = "";
                return;
              }
              const next = [...file.tags, tag];
              setFile({ ...file, tags: next });
              e.currentTarget.value = "";
              try {
                const res = await fetch(`/api/files/${file.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ tags: next }),
                });
                if (!res.ok) throw new Error("PATCH failed");
                onChanged?.();
              } catch (err) {
                setFile({ ...file, tags: file.tags });
                console.error("Failed to add tag:", err);
              }
            }}
          />
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {editing ? (
          <MarkdownEditor content={editContent} onChange={setEditContent} />
        ) : viewHistory ? (
          <div className="h-full overflow-auto bg-gray-50 dark:bg-[#0a0a0a] p-6">
            <div className="max-w-2xl mx-auto space-y-4">
              <h3 className="text-sm font-bold text-[var(--text-secondary)] uppercase tracking-widest mb-6">
                Version History (Time Travel)
              </h3>
              {fetchingHistory ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-20 w-full rounded-lg" />
                  ))}
                </div>
              ) : history.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-gray-500">No version history found for this file.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {history.map((commit) => (
                    <div 
                      key={commit.hash}
                      className="bg-white dark:bg-[#1a1a1a] border border-[var(--border)] rounded-lg p-4 flex items-center justify-between hover:border-amber-accent/50 transition-colors shadow-sm"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-[var(--text-primary)] truncate">
                          {commit.message}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-[var(--text-secondary)] uppercase tracking-tighter font-bold">
                          <span>{new Date(commit.date).toLocaleString()}</span>
                          <span className="opacity-30">•</span>
                          <span className="font-mono text-amber-accent">{commit.hash.substring(0, 7)}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleRestore(commit.hash)}
                        className="ml-4 btn btn-md"
                      >
                        RESTORE
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            {file.path.endsWith(".mmd") ? (
              <MermaidViewer source={file.content} className="p-8" filename={file.title} />
            ) : (
              <MarkdownViewer content={file.content} className="p-8" />
            )}
          </div>
        )}
      </div>

      <DeleteConfirmDialog
        open={deleteDialogOpen}
        title={file.title}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
      />

      <GitErrorDialog
        open={gitErrorOpen}
        onClose={() => setGitErrorOpen(false)}
        error={gitErrorMessage}
      />
    </div>
  );
}

function formatRelative(iso?: string): string {
  if (!iso) return "";
  const ts = new Date(iso).getTime();
  if (!isFinite(ts)) return iso;
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
