"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileListFilter } from "./file-list-filter";
import { FileItem } from "./file-item";
import { UploadFilesDialog } from "./upload-files-dialog";
import { ClipUrlDialog } from "./clip-url-dialog";
import { OnboardModal } from "./onboard-modal";

interface Project {
  id: number;
  name: string;
  path: string;
  remote_url: string | null;
}

interface File {
  id: number;
  path: string;
  title: string;
  updated_at: string;
  created_at: string;
  project_id?: number;
  size_bytes?: number | null;
  est_tokens?: number | null;
  favorite?: boolean;
  tags?: string[] | null;
}

type SortBy = "name" | "updated_at" | "created_at";

interface FileListProps {
  files: File[];
  selectedFileId: number | null;
  onSelectFile: (fileId: number) => void;
  sortBy: SortBy;
  onSortChange: (sortBy: SortBy) => void;
  selectedFolder: string | null;
  selectedProject: Project | null;
  selectedSection?: "projects" | "knowledge" | "favorites" | null;
  basePath?: string | null;
  onSync: () => void;
  onUnregisterProject?: () => void;
  onDeleteFolder?: () => void;
  loading?: boolean;
  projects?: Project[];
  onUploaded?: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  onNewFile: () => void;
}

export function FileList({
  files,
  selectedFileId,
  onSelectFile,
  sortBy,
  onSortChange,
  selectedFolder,
  selectedProject,
  selectedSection,
  basePath,
  onSync,
  onUnregisterProject,
  onDeleteFolder,
  loading,
  projects,
  onUploaded,
  onRefresh,
  refreshing,
  onNewFile,
}: FileListProps) {
  const [filter, setFilter] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [clipDialogOpen, setClipDialogOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSelectedIds(new Set()); }, [selectedFolder, selectedProject?.id, selectedSection, filter, sortBy]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (newMenuOpen && newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false);
      }
      if (projectMenuOpen && projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [newMenuOpen, projectMenuOpen]);

  const filteredAndSorted = useMemo(() => {
    let result = [...files];

    // Normalize separators and handle nulls safely to prevent UI crashes.
    const norm = (p: string | null | undefined) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    
    const isInFolder = (filePath: string | null | undefined, folderBase: string | null | undefined) => {
      if (!filePath || !folderBase) return false;
      const f = norm(filePath);
      const b = norm(folderBase) + "/";
      if (!f.startsWith(b)) return false;
      const rel = f.slice(b.length);
      return rel.length > 0 && !rel.includes("/");
    };

    const isUnderFolder = (filePath: string | null | undefined, folderBase: string | null | undefined) => {
      if (!filePath || !folderBase) return false;
      const f = norm(filePath);
      const b = norm(folderBase) + "/";
      return f.startsWith(b);
    };

    if (selectedSection === "projects") {
      if (selectedProject) {
        const base = basePath || selectedProject.path;
        if (base) {
          const normalizedBase = norm(base) + "/";
          if (selectedFolder) {
            // Recursive: show every file under the selected folder, not
            // just direct children — otherwise picking a folder with only
            // subfolders looks empty.
            const folderPrefix = normalizedBase + norm(selectedFolder);
            result = result.filter((f) => isUnderFolder(f.path, folderPrefix));
          } else {
            // No folder selected: show ALL files in the project (recursive),
            // not just files directly at the project root — many projects
            // keep all their context files in subfolders (e.g. `.claude/`).
            result = result.filter((f) => f.project_id === selectedProject.id);
          }
        } else {
          result = result.filter((f) => f.project_id === selectedProject.id);
        }
      } else {
        result = [];
      }
    } else if (selectedSection === "favorites") {
      // files is already pre-filtered by page.tsx, and favorites ignore folders
      result = [...files];
    } else if (selectedSection === "knowledge") {
      result = result.filter((f) => !f.project_id);
      if (basePath) {
        const normalizedBase = norm(basePath) + "/";
        if (selectedFolder) {
          // Recursive — same reasoning as the projects branch above.
          const folderPrefix = normalizedBase + norm(selectedFolder);
          result = result.filter((f) => isUnderFolder(f.path, folderPrefix));
        } else {
          // KB root: show all KB files (recursive). The folder tree
          // shows nested files at every depth — middle pane should match
          // it. The previous "direct children only" comment was wrong:
          // KB files all have !project_id, no cross-project leakage risk.
          // Already filtered by !project_id above.
        }
      }
    } else {
      result = [];
    }

    switch (sortBy) {
      case "name":
        result.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "updated_at":
        result.sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        break;
      case "created_at":
        result.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        break;
    }

    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter((f) => f.title.toLowerCase().includes(q));
    }

    return result;
  }, [files, sortBy, selectedFolder, selectedProject, selectedSection, basePath, filter]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-1.5 py-1.5 border-b border-[var(--border)]">
        <div className="relative flex-1" ref={newMenuRef}>
          <button
            type="button"
            onClick={() => setNewMenuOpen((v) => !v)}
            className="btn btn-sm w-full"
            title="Add content to the knowledge base"
          >
            New <span className="opacity-60 text-xs">▾</span>
          </button>
          {newMenuOpen && (
            <div className="dropdown-menu left-0 w-full">
              <button
                type="button"
                onClick={() => { setNewMenuOpen(false); onNewFile(); }}
                className="dropdown-item"
              >
                <span>+</span> New File
              </button>
              <button
                type="button"
                onClick={() => { setNewMenuOpen(false); setUploadOpen(true); }}
                className="dropdown-item"
              >
                <span>↑</span> Upload Files
              </button>
              <button
                type="button"
                onClick={() => { setNewMenuOpen(false); setClipDialogOpen(true); }}
                className="dropdown-item"
              >
                <span>↗</span> Clip URL
              </button>
            </div>
          )}
        </div>
        {selectedSection === "projects" && selectedProject && (
          <div className="relative flex-1" ref={projectMenuRef}>
            <button
              type="button"
              onClick={() => setProjectMenuOpen((v) => !v)}
              className="btn btn-sm w-full"
              title="Project actions"
            >
              Project <span className="opacity-60 text-xs">▾</span>
            </button>
            {projectMenuOpen && (
              <div className="dropdown-menu left-0 w-full">
                <a
                  href={selectedFolder 
                    ? `/api/export/zip?project_id=${selectedProject.id}&folder=${encodeURIComponent(selectedFolder)}`
                    : `/api/export/zip?project_id=${selectedProject.id}`}
                  download
                  onClick={() => setProjectMenuOpen(false)}
                  className="dropdown-item"
                >
                  <span>↓</span> Export ZIP
                </a>
                <button
                  type="button"
                  onClick={() => { setProjectMenuOpen(false); onSync(); }}
                  className="dropdown-item"
                >
                  <span>↻</span> Sync Project
                </button>
                <button
                  type="button"
                  onClick={() => { setProjectMenuOpen(false); onRefresh(); }}
                  className="dropdown-item"
                >
                  <span>🔍</span> Scan for New Files
                </button>
                <button
                  type="button"
                  onClick={() => { setProjectMenuOpen(false); setOnboardOpen(true); }}
                  className="dropdown-item"
                >
                  <span>✨</span> Onboard Agent
                </button>
                {!selectedFolder && onUnregisterProject && (
                  <button
                    type="button"
                    onClick={() => { setProjectMenuOpen(false); onUnregisterProject(); }}
                    className="dropdown-item text-red-500 hover:text-red-600 hover:bg-red-500/10"
                  >
                    <span>✕</span> Unregister
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => { setSelectMode((v) => !v); setSelectedIds(new Set()); }}
          className="btn btn-sm flex-1"
          title="Toggle multi-select"
        >
          {selectMode ? "Selected" : "Select"}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className={`btn btn-sm ${refreshing ? "opacity-50" : ""}`}
          title="Refresh (scan disk for changes)"
        >
          {refreshing ? "..." : "↻"}
        </button>
      </div>
      <div className="px-3 py-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-[var(--text-secondary)] border-b border-[var(--border)]">
        <span>
          {filteredAndSorted.length} {filteredAndSorted.length === 1 ? "file" : "files"}
          {(() => {
            const total = filteredAndSorted.reduce((sum, f) => sum + (f.est_tokens ?? 0), 0);
            return total > 0 ? ` · ~${formatTokens(total)} tok` : "";
          })()}
        </span>
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortBy)}
            className="bg-transparent text-[11px] uppercase tracking-wider focus:outline-none cursor-pointer"
          >
            <option value="updated_at" className="bg-[var(--bg-primary)] text-[var(--text-primary)]">updated</option>
            <option value="created_at" className="bg-[var(--bg-primary)] text-[var(--text-primary)]">created</option>
            <option value="name" className="bg-[var(--bg-primary)] text-[var(--text-primary)]">name</option>
          </select>
        </div>
      </div>
      {files.length > 10 && <FileListFilter value={filter} onChange={setFilter} />}

      {(() => {
        // Intersect selection with the visible set so the badge count and
        // download URL never include files no longer shown after a filter
        // or sort change.
        const visibleIds = new Set(filteredAndSorted.map((f) => f.id));
        const visibleSelected = [...selectedIds].filter((id) => visibleIds.has(id));
        // /api/export/zip now requires `scope` (kb | <projectId>) to avoid
        // cross-project read-anything via file_ids. Mirror the current pane.
        const scope = selectedProject ? String(selectedProject.id) : "kb";
        const handleBulkDelete = async () => {
          if (visibleSelected.length === 0 || bulkDeleting) return;
          setBulkDeleting(true);
          // Sequential to keep ordering predictable in the dev log and to
          // avoid contending on the same git lock from many parallel DELETEs.
          const failures: Array<{ id: number; error: string }> = [];
          for (const id of visibleSelected) {
            try {
              const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
              if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                failures.push({ id, error: body?.error ?? `HTTP ${res.status}` });
              }
            } catch (e: any) {
              failures.push({ id, error: e?.message ?? "Network error" });
            }
          }
          setBulkDeleting(false);
          setBulkConfirmOpen(false);
          setSelectedIds(new Set());
          // Refresh the list either way; the user can see what's left.
          onRefresh();
          if (failures.length > 0) {
            console.error("[bulk-delete] failures:", failures);
            alert(
              `Deleted ${visibleSelected.length - failures.length}/${visibleSelected.length} files.\n` +
              `${failures.length} failed:\n` +
              failures.slice(0, 5).map((f) => `  #${f.id}: ${f.error}`).join("\n") +
              (failures.length > 5 ? `\n  …and ${failures.length - 5} more (see console)` : ""),
            );
          }
        };
        return (
      <div className="flex-1 overflow-y-auto">
        {selectMode && visibleSelected.length > 0 && (
          <div className="sticky top-0 z-10 px-3 py-2 bg-[var(--bg-secondary)] border-b border-amber-accent/40 flex items-center justify-between gap-2 text-[11px]">
            <span className="whitespace-nowrap shrink-0">{visibleSelected.length} selected</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <a
                href={`/api/export/zip?file_ids=${visibleSelected.join(",")}&scope=${scope}`}
                download
                className="px-2 py-1 bg-amber-accent text-black font-bold rounded whitespace-nowrap leading-none"
                title="Download selected files as ZIP"
              >
                ZIP
              </a>
              <button
                type="button"
                onClick={() => setBulkConfirmOpen(true)}
                disabled={bulkDeleting}
                className={`px-2 py-1 bg-red-600 text-white font-bold rounded whitespace-nowrap leading-none ${bulkDeleting ? "opacity-50" : "hover:bg-red-700"}`}
                title={`Delete ${visibleSelected.length} selected file(s)`}
              >
                {bulkDeleting ? "…" : "Delete"}
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="px-2 py-1 border border-[var(--border)] rounded whitespace-nowrap leading-none hover:bg-[var(--bg-tertiary)]"
                title="Clear selection"
              >
                Clear
              </button>
            </div>
          </div>
        )}
        {bulkConfirmOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-5 max-w-md w-full shadow-2xl">
              <h2 className="text-base font-bold text-[var(--text-primary)] mb-2">
                Delete {visibleSelected.length} file{visibleSelected.length === 1 ? "" : "s"}?
              </h2>
              <p className="text-sm text-[var(--text-secondary)] mb-4">
                Knowledge Base files will be removed from disk and the deletion will be
                committed to git (recoverable via Time Travel). Project files are only
                un-indexed; the source file on disk is left intact.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setBulkConfirmOpen(false)}
                  disabled={bulkDeleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`px-3 py-1.5 bg-red-600 text-white font-bold rounded ${bulkDeleting ? "opacity-50" : "hover:bg-red-700"}`}
                  onClick={handleBulkDelete}
                  disabled={bulkDeleting}
                >
                  {bulkDeleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
        {filteredAndSorted.length > 0 ? (
          filteredAndSorted.map((file) => (
            <FileItem
              key={file.id}
              id={file.id}
              title={file.title}
              updatedAt={file.updated_at}
              active={file.id === selectedFileId}
              onClick={() => onSelectFile(file.id)}
              estTokens={file.est_tokens}
              favorite={file.favorite}
              tags={file.tags ?? undefined}
              selectMode={selectMode}
              selected={selectedIds.has(file.id)}
              onToggleSelect={() => {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(file.id)) next.delete(file.id);
                  else next.add(file.id);
                  return next;
                });
              }}
            />
          ))
        ) : loading || (selectedSection === "projects" && !selectedProject) ? (
          <div aria-label="Loading files" role="status">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="px-3 py-2 border-b border-[var(--bg-tertiary)]">
                <div className="skeleton h-3.5" style={{ width: `${60 + ((i * 13) % 30)}%` }} />
                <div className="skeleton h-2.5 mt-2" style={{ width: `${30 + ((i * 7) % 20)}%` }} />
              </div>
            ))}
          </div>
        ) : !selectedSection ? (
          <div className="flex flex-col items-center justify-center py-16 text-[#475569] dark:text-[#94A3B8] gap-4">
            <span className="text-6xl opacity-30 dark-icon">📂</span>
            <div className="text-center px-6">
              <p className="text-lg font-bold text-[var(--text-primary)]">No Selection</p>
              <p className="text-sm text-[var(--text-secondary)] mt-2">
                Please select a project or the Knowledge Base from the sidebar to view files.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-[#475569] dark:text-[#94A3B8] gap-4">
            <span className="text-6xl opacity-30 dark-icon">📂</span>
            <div className="text-center px-6">
              <p className="text-lg font-bold text-[var(--text-primary)]">Folder is empty</p>
              <p className="text-sm text-[var(--text-secondary)] mt-2">
                This folder doesn't contain any indexed context files.
              </p>
            </div>

            {selectedSection === "knowledge" && selectedFolder && onDeleteFolder && (
              <div className="mt-6 flex flex-col items-center gap-3">
                <div className="h-px w-16 bg-[var(--border)]" />
                <button
                  onClick={onDeleteFolder}
                  className="px-6 py-2.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-500/20 rounded-lg text-sm font-bold hover:bg-red-200 dark:hover:bg-red-900/50 transition-all btn-press shadow-sm"
                >
                  DELETE THIS FOLDER
                </button>
                <p className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Permanent Action</p>
              </div>
            )}
          </div>
        )}
      </div>
        );
      })()}
      <UploadFilesDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        projects={projects ?? []}
        defaultProjectId={selectedSection === "projects" && selectedProject ? selectedProject.id : null}
        defaultFolder={selectedFolder ?? ""}
        onUploaded={() => {
          setUploadOpen(false);
          onUploaded?.();
        }}
      />
      <ClipUrlDialog
        open={clipDialogOpen}
        onClose={() => setClipDialogOpen(false)}
        onClipped={() => { onRefresh(); }}
      />
      {selectedProject && (
        <OnboardModal
          isOpen={onboardOpen}
          onClose={() => setOnboardOpen(false)}
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          onOnboarded={() => { onRefresh(); }}
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
