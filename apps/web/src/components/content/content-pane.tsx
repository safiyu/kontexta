"use client";

import { useState, useEffect, useRef } from "react";
import { FolderOpen, AlertTriangle, Search } from "lucide-react";
import { toast } from "sonner";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import stripMarkdown from "strip-markdown";
import { MarkdownViewer } from "./markdown-viewer";
import { MermaidViewer } from "./mermaid-viewer";
import { HtmlViewer } from "./html-viewer";
import { HtmlEditor } from "./html-editor";
import { MarkdownEditor } from "./markdown-editor";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { GitErrorDialog } from "./git-error-dialog";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";

const TrashIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const DownloadIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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

interface LoadError {
  kind: "disk_missing" | "row_missing" | "read_failed" | "http" | "network";
  message: string;
  status?: number;
  path?: string;
}

export function ContentPane({ fileId, onDelete, onChanged, onDirtyChange }: ContentPaneProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
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
  const [gitErrorTitle, setGitErrorTitle] = useState("");
  const [gitErrorBody, setGitErrorBody] = useState("");
  const [gitErrorDetail, setGitErrorDetail] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [removingOrphan, setRemovingOrphan] = useState(false);
  const [editHtmlOpen, setEditHtmlOpen] = useState(false);

  const baseFilename = () => (file?.title || "untitled").replace(/\.(md|mmd)$/i, "");

  const handleExportMarkdown = () => {
    if (!file) return;
    downloadBlob(file.content, `${baseFilename()}.md`, "text/markdown");
    toast.success("Exported Markdown");
  };

  const handleExportText = async () => {
    if (!file) return;
    // strip-markdown's defaults delete code blocks and tables entirely
    // (not just their syntax) — `keep` preserves the underlying content;
    // `tableCell` needs its own entry since it has a separate default
    // handler independent of `table`. remark-gfm is required for both
    // parsing and re-stringifying GFM tables correctly.
    const result = await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(stripMarkdown, { keep: ["code", "inlineCode", "table", "tableCell"] })
      .use(remarkStringify)
      .process(file.content);
    downloadBlob(String(result), `${baseFilename()}.txt`, "text/plain");
    toast.success("Exported text");
  };

  const [exportingPdf, setExportingPdf] = useState(false);

  const handleExportPdf = async () => {
    if (!file) return;
    setExportingPdf(true);
    const toastId = toast.loading("Generating PDF…");
    try {
      const res = await fetch(`/api/files/${file.id}/export-pdf`);
      if (!res.ok) {
        const text = await res.text();
        let message = `Failed to export PDF (HTTP ${res.status})`;
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error) message = parsed.error;
        } catch {
          // Response wasn't JSON (e.g. a framework error page) — log the
          // raw body so it's still visible for debugging.
          console.error("[export-pdf] non-JSON error response:", text);
        }
        toast.error(message, { id: toastId });
        return;
      }
      const disposition = res.headers.get("content-disposition") || "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `${baseFilename()}.pdf`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Exported PDF", { id: toastId });
    } catch (err) {
      console.error("[export-pdf] request failed:", err);
      toast.error("Failed to export PDF — check the browser console for details.", { id: toastId });
    } finally {
      setExportingPdf(false);
    }
  };

  const handleRefresh = async () => {
    if (!fileId) return;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/files/${fileId}`);
      if (response.ok) {
        const data = await response.json();
        setFile(data);
        setEditContent(data.content);
      } else {
        toast.error(`Failed to refresh file (HTTP ${response.status})`);
      }
    } catch (error: any) {
      toast.error(`Failed to refresh file: ${error?.message ?? "Network error"}`);
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

  // Keep onDirtyChange in a ref so the dirty-state effect can call the latest
  // callback without listing it as a dependency. Parents commonly pass an
  // inline arrow (`(d) => { ref.current = d }`), which would otherwise cause
  // the cleanup-only effect below to fire on every parent render and flip the
  // flag to false mid-edit.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  useEffect(() => {
    const dirty = editing && file != null && editContent !== file.content;
    onDirtyChangeRef.current?.(dirty);
  }, [editing, editContent, file?.content]);
  useEffect(() => () => { onDirtyChangeRef.current?.(false); }, []);

  useEffect(() => {
    if (fileId === null) {
      setFile(null);
      setLoadError(null);
      setEditing(false);
      setViewHistory(false);
      return;
    }

    const controller = new AbortController();
    const fetchFile = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const response = await fetch(`/api/files/${fileId}`, { signal: controller.signal });
        if (fileIdRef.current !== fileId) return;
        if (response.ok) {
          const data = await response.json();
          if (fileIdRef.current !== fileId) return;
          setFile(data);
          setEditContent(data.content);
        } else {
          // Surface the error instead of silently no-op'ing — otherwise a
          // click on a file whose row points at a missing disk path just
          // does nothing, and the user can't tell whether the click
          // registered or the file is broken.
          let body: any = null;
          try { body = await response.json(); } catch {}
          if (fileIdRef.current !== fileId) return;
          setFile(null);
          setLoadError({
            kind: body?.kind ?? "http",
            message: body?.error ?? `Request failed with HTTP ${response.status}`,
            status: response.status,
            path: body?.path,
          });
        }
      } catch (error: any) {
        if (error?.name === "AbortError") return;
        console.error("Failed to fetch file:", error);
        if (fileIdRef.current !== fileId) return;
        setFile(null);
        setLoadError({
          kind: "network",
          message: error?.message ?? "Network error",
        });
      } finally {
        if (fileIdRef.current === fileId) setLoading(false);
      }
    };

    fetchFile();
    setViewHistory(false);
    return () => controller.abort();
  }, [fileId]);

  const handleRemoveOrphanFromIndex = async () => {
    if (fileId == null) return;
    setRemovingOrphan(true);
    try {
      const res = await fetch(`/api/files/${fileId}`, { method: "DELETE" });
      if (res.ok) {
        setLoadError(null);
        setFile(null);
        onDelete(fileId).catch((e) => console.error("onDelete after orphan remove failed:", e));
        onChanged?.();
      } else {
        const body = await res.json().catch(() => ({}));
        setLoadError({
          kind: "http",
          message: body?.error ?? `Remove failed: HTTP ${res.status}`,
          status: res.status,
        });
      }
    } catch (e: any) {
      setLoadError({
        kind: "network",
        message: e?.message ?? "Network error while removing orphan row",
      });
    } finally {
      setRemovingOrphan(false);
    }
  };

  const fetchHistory = async () => {
    if (!fileId) return;
    const issuedFor = fileId;
    setFetchingHistory(true);
    try {
      const response = await fetch(`/api/files/${fileId}/history`);
      if (response.ok) {
        const data = await response.json();
        if (fileIdRef.current !== issuedFor) return;
        setHistory(data);
      }
    } catch (error) {
      console.error("Failed to fetch history:", error);
    } finally {
      if (fileIdRef.current === issuedFor) setFetchingHistory(false);
    }
  };

  const handleRestore = async (hash: string) => {
    if (!fileId) return;
    const issuedFor = fileId;
    try {
      const response = await fetch(`/api/files/${fileId}/history/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash }),
      });
      if (response.ok) {
        const data = await response.json();
        if (fileIdRef.current !== issuedFor) return;
        setFile((prev) => (prev && prev.id === issuedFor ? { ...prev, content: data.content } : prev));
        setEditContent(data.content);
        setViewHistory(false);
        toast.success("Restored from history");
      } else {
        const body = await response.json().catch(() => ({}));
        toast.error(body?.error || "Failed to restore version");
      }
    } catch (error: any) {
      toast.error(`Failed to restore version: ${error?.message ?? "Network error"}`);
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
        toast.success("Saved");
        if (updatedFile.git_warning) {
          setGitErrorTitle("Git commit failed");
          setGitErrorBody("Your changes were saved to the database, but Kontexta could not create a Git history entry for this file.");
          setGitErrorDetail(updatedFile.git_warning);
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
          setGitErrorTitle("File changed on disk");
          setGitErrorBody(
            "This file was NOT saved — it was modified elsewhere since you opened it. Disk content has been reloaded below; your edits are still in the editor. Click Save again to overwrite with your edits."
          );
          setGitErrorDetail(undefined);
          setGitErrorOpen(true);
        }
      } else {
        let msg = `Save failed (${response.status})`;
        try { const data = await response.json(); if (data?.error) msg = data.error; } catch {}
        if (fileIdRef.current === savingFileId) {
          setGitErrorTitle("Save failed");
          setGitErrorBody("Your changes were NOT saved.");
          setGitErrorDetail(msg);
          setGitErrorOpen(true);
        }
      }
    } catch (error: any) {
      console.error("Failed to save file:", error);
      if (fileIdRef.current === savingFileId) {
        setGitErrorTitle("Save failed");
        setGitErrorBody("Your changes were NOT saved — a network error occurred.");
        setGitErrorDetail(error?.message ?? "Network error while saving");
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
      <div className="h-full flex flex-col items-center justify-center animate-fade-in">
        <EmptyState
          icon={<FolderOpen className="w-16 h-16 opacity-40 dark-icon" aria-hidden />}
          title="Select a file to preview"
          hint="Choose a file from the list on the left"
        />
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
    // Specific UX for each failure mode so the user knows whether to:
    //  - Remove the orphan row (disk file vanished out from under the index)
    //  - Refresh / retry (transient HTTP / network)
    //  - Live with it (row truly missing — likely a stale selection)
    if (loadError?.kind === "disk_missing") {
      return (
        <div className="h-full flex flex-col items-center justify-center text-[var(--text-secondary)] gap-4 animate-fade-in p-8">
          <AlertTriangle className="w-16 h-16 opacity-40 dark-icon" aria-hidden />
          <div className="text-center max-w-lg">
            <p className="text-lg font-bold text-[var(--text-primary)]">File is missing on disk</p>
            <p className="text-sm font-medium text-[var(--text-secondary)] mt-2">
              The index still has a row for this file, but the file at the path below no longer exists.
              This usually happens when the file was deleted while the watcher wasn't running.
            </p>
            {loadError.path && (
              <pre className="mt-3 p-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs overflow-x-auto rounded">
                {loadError.path}
              </pre>
            )}
            <button
              type="button"
              className="btn btn-sm mt-4"
              onClick={handleRemoveOrphanFromIndex}
              disabled={removingOrphan}
            >
              {removingOrphan ? "Removing…" : "Remove from index"}
            </button>
          </div>
        </div>
      );
    }
    if (loadError) {
      return (
        <div className="h-full flex flex-col items-center justify-center text-[var(--text-secondary)] gap-3 animate-fade-in p-8">
          <AlertTriangle className="w-16 h-16 opacity-40 dark-icon" aria-hidden />
          <div className="text-center max-w-lg">
            <p className="text-lg font-bold text-[var(--text-primary)]">
              Failed to load file{loadError.status ? ` (HTTP ${loadError.status})` : ""}
            </p>
            <p className="text-sm font-medium text-[var(--text-secondary)] mt-2 break-words">
              {loadError.message}
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="h-full flex flex-col items-center justify-center animate-fade-in">
        <EmptyState
          icon={<Search className="w-16 h-16 opacity-40 dark-icon" aria-hidden />}
          title="File not found"
          hint="This file may have been moved or deleted"
        />
      </div>
    );
  }

  return (
    <div key={fileId} className="h-full flex flex-col animate-fade-in">
      <div className="h-10 px-4 border-b border-[var(--border)] flex items-center gap-4 text-[14px] sticky top-0 bg-[var(--bg-primary)] z-10">
        {(["view", "edit", "history"] as const)
          .filter((mode) => mode !== "edit" || !file.path.endsWith(".html"))
          .map((mode) => {
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
              {file.path.endsWith(".html") && (
                <button
                  type="button"
                  onClick={() => setEditHtmlOpen(true)}
                  className="btn btn-md"
                  aria-label="Edit HTML source"
                  title="Edit HTML source"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 opacity-70">
                    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
              )}
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
                  } catch (e: any) {
                    // Roll back optimistic toggle.
                    setFile({ ...file, favorite: !next });
                    toast.error(`Failed to update favorite: ${e?.message ?? "Network error"}`);
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
              <DropdownMenu
                trigger={
                  <button
                    disabled={exportingPdf}
                    className="btn btn-md"
                    aria-label="Export file"
                    title={exportingPdf ? "Generating PDF…" : "Export file"}
                  >
                    <DownloadIcon className={`w-4 h-4 opacity-70 ${exportingPdf ? "animate-pulse" : ""}`} />
                  </button>
                }
                items={[
                  { label: "Markdown (.md)", onSelect: handleExportMarkdown },
                  { label: "Text (.txt)", onSelect: () => { handleExportText(); } },
                  { label: "PDF", onSelect: handleExportPdf },
                ]}
              />
              <button
                onClick={() => setDeleteDialogOpen(true)}
                className="btn btn-md btn-destructive"
                aria-label="Delete file"
                title="Delete file"
              >
                <TrashIcon className="w-4 h-4 opacity-70" />
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
                  const fileId = file.id;
                  const original = file.tags;
                  const next = original.filter((x) => x !== t);
                  setFile((prev) => (prev && prev.id === fileId ? { ...prev, tags: next } : prev));
                  try {
                    const res = await fetch(`/api/files/${fileId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tags: next }),
                    });
                    if (!res.ok) throw new Error("PATCH failed");
                    onChanged?.();
                  } catch (e: any) {
                    setFile((prev) => (prev && prev.id === fileId ? { ...prev, tags: original } : prev));
                    toast.error(`Failed to remove tag: ${e?.message ?? "Network error"}`);
                  }
                }}
                className="text-[var(--text-secondary)] hover:text-[var(--danger)]"
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
              const fileId = file.id;
              const original = file.tags;
              const next = [...original, tag];
              setFile((prev) => (prev && prev.id === fileId ? { ...prev, tags: next } : prev));
              e.currentTarget.value = "";
              try {
                const res = await fetch(`/api/files/${fileId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ tags: next }),
                });
                if (!res.ok) throw new Error("PATCH failed");
                onChanged?.();
              } catch (err: any) {
                setFile((prev) => (prev && prev.id === fileId ? { ...prev, tags: original } : prev));
                toast.error(`Failed to add tag: ${err?.message ?? "Network error"}`);
              }
            }}
          />
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {editing ? (
          <MarkdownEditor content={editContent} onChange={setEditContent} />
        ) : viewHistory ? (
          <div className="h-full overflow-auto bg-[var(--bg-secondary)] p-6">
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
                  <p className="text-[var(--muted)]">No version history found for this file.</p>
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
            ) : file.path.endsWith(".html") ? (
              <HtmlViewer html={file.content} />
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
        title={gitErrorTitle}
        body={gitErrorBody}
        detail={gitErrorDetail}
      />

      {editHtmlOpen && file && (
        <HtmlEditor
          fileId={file.id}
          initial={file.content}
          onClose={() => setEditHtmlOpen(false)}
          onSaved={(updatedFile) => {
            const issuedFor = file.id;
            if (fileIdRef.current !== issuedFor) {
              if (updatedFile.git_warning) {
                console.warn(`[kontexta] git_warning for stale file ${issuedFor}:`, updatedFile.git_warning);
              }
              return;
            }
            setFile(updatedFile);
            if (updatedFile.git_warning) {
              setGitErrorTitle("Git commit failed");
              setGitErrorBody("Your changes were saved to the database, but Kontexta could not create a Git history entry for this file.");
              setGitErrorDetail(updatedFile.git_warning);
              setGitErrorOpen(true);
            }
          }}
        />
      )}
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
