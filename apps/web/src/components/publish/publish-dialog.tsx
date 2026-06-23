"use client";

import { useState, useEffect, useCallback } from "react";

interface PublishConfig {
  folders: string[];
  title: string;
  brand: string;
  theme: "default" | "minimal" | "api-ref";
  llmsTxt: boolean;
  seo: boolean;
}

export interface PublishResult {
  success: boolean;
  output?: string;
  docCount?: number;
  endpointCount?: number;
  termCount?: number;
  llmsTxt?: string | null;
  error?: string;
}

interface ProjectOption {
  id: number;
  name: string;
  slug: string;
}

/** Display name: "ProjectName: folder" for project folders, plain name for KB folders. */
function displayName(folder: string, projectSlug: string | null): string {
  if (projectSlug) {
    return `${projectSlug}/${folder}`;
  }
  return folder;
}

export function PublishDialog({ isOpen, onClose, mode = "publish", onSwitchToPublish, onPublishSuccess }: { isOpen: boolean; onClose: () => void; mode?: "publish" | "view"; onSwitchToPublish?: () => void; onPublishSuccess?: (result: PublishResult) => void }) {
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [config, setConfig] = useState<PublishConfig>({
    folders: [],
    title: "Kontexta Docs",
    brand: "Kontexta",
    theme: "default",
    llmsTxt: true,
    seo: true,
  });
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewExists, setViewExists] = useState(false);

  // Project selection state
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (mode === "view") {
        checkPublished();
      } else {
        fetchProjects();
        fetchFolders();
      }
      setResult(null);
      setError(null);
    }
  }, [isOpen, mode]);

  useEffect(() => {
    if (isOpen && mode === "publish") {
      fetchFolders();
    }
  }, [isOpen, mode, selectedProjectId]);

  const checkPublished = async () => {
    setViewLoading(true);
    try {
      const res = await fetch("/api/publish");
      if (res.ok) {
        const data = await res.json();
        setViewExists(data.exists || false);
      }
    } catch {
      setViewExists(false);
    } finally {
      setViewLoading(false);
    }
  };

  const fetchProjects = async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data || []);
      }
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    }
  };

  const fetchFolders = async () => {
    try {
      const url = selectedProjectId
        ? `/api/folders?projectId=${selectedProjectId}`
        : "/api/folders/";
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const list: string[] = data.folders || [];
        setFolders(list);
        // Auto-select everything by default. Previously the dialog loaded
        // with zero selections — the orange Publish button stayed disabled
        // (no onClick fires from a disabled <button>) and to the user it
        // looked like "click does nothing, no error". The user can still
        // untick anything they don't want before publishing.
        setSelectedFolders(list);
      }
    } catch (err) {
      console.error("Failed to fetch folders:", err);
    }
  };

  const toggleFolder = (folderName: string) => {
    setSelectedFolders((prev) =>
      prev.includes(folderName)
        ? prev.filter((f) => f !== folderName)
        : [...prev, folderName]
    );
  };

  const selectAllFolders = () => {
    setSelectedFolders([...folders]);
  };

  const clearFolders = () => {
    setSelectedFolders([]);
  };

  const handlePublish = async () => {
    if (selectedFolders.length === 0) {
      setError("Please select at least one folder to publish.");
      return;
    }

    setPublishing(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folders: selectedFolders,
          title: config.title,
          brand: config.brand,
          theme: config.theme,
          llmsTxt: config.llmsTxt,
          seo: config.seo,
          projectId: selectedProjectId,
        }),
      });

      const data: PublishResult = await res.json();

      if (!data.success) {
        // Failures stay in the dialog so the user can read the message and
        // adjust folders/options without losing context.
        setResult(data);
        setError(data.error || "Publish failed");
      } else {
        // Success: close the dialog and bubble the result up so the parent
        // can show a persistent toast (dismissable, with View Published).
        // Previously the success panel was rendered at the bottom of the
        // dialog where the user wouldn't see it without scrolling — they
        // could publish from the top and have no idea anything happened.
        onPublishSuccess?.(data);
        onClose();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed";
      setError(message);
    } finally {
      setPublishing(false);
    }
  };

  if (!isOpen) return null;

  const isProjectScope = selectedProjectId !== null;
  const activeProject = projects.find((p) => p.id === selectedProjectId);
  const isViewMode = mode === "view";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border)] shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col" style={isViewMode ? { maxWidth: "90vw", maxHeight: "85vh" } : undefined}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-[#B4781E]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4h16v16H4z" />
              <path d="M9 9h6v6H9z" />
              <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
            </svg>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              {isViewMode ? "View Published Site" : "Publish Documentation"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {isViewMode ? (
            /* View Published Mode */
            <div className="flex-1 flex flex-col">
              {viewLoading ? (
                <div className="flex items-center justify-center h-full p-8">
                  <div className="text-center space-y-3">
                    <svg className="w-8 h-8 animate-spin mx-auto text-[#B4781E]" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <p className="text-sm text-[var(--text-secondary)]">Checking for published site...</p>
                  </div>
                </div>
              ) : viewExists ? (
                <iframe
                  src="/api/publish/html"
                  title="Published Site"
                  className="w-full h-full border-0 bg-white"
                  sandbox="allow-same-origin allow-scripts allow-popups"
                />
              ) : (
                <div className="flex items-center justify-center h-full p-8">
                  <div className="text-center space-y-4 max-w-md">
                    <svg className="w-12 h-12 mx-auto text-[var(--text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 4h16v16H4z" />
                      <path d="M9 9h6v6H9z" />
                      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
                    </svg>
                    <p className="text-sm text-[var(--text-secondary)]">
                      No published site found. Publish some content first to generate a static site.
                    </p>
                    <button
                      onClick={() => onSwitchToPublish?.()}
                      className="px-4 py-2 rounded-xl text-sm font-medium bg-[#B4781E] text-white hover:bg-[#9A6818] transition-colors"
                    >
                      Create a Publish
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Publish Mode — original form */
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Source Scope Selection */}
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                  Source Scope
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedProjectId(null)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                      !isProjectScope
                        ? "bg-[#B4781E]/10 text-[#B4781E] border border-[#B4781E]/30"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border)]"
                    }`}
                  >
                    Knowledge Base
                  </button>
                  <button
                    onClick={() => setSelectedProjectId(projects[0]?.id ?? null)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                      isProjectScope
                        ? "bg-[#B4781E]/10 text-[#B4781E] border border-[#B4781E]/30"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border)]"
                    }`}
                  >
                    Project
                    {activeProject && (
                      <span className="ml-1 text-xs opacity-70">
                        ({activeProject.name})
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {/* Project Selector (shown when project scope is selected) */}
              {isProjectScope && (
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                    Select Project
                  </label>
                  <select
                    value={selectedProjectId ?? ""}
                    onChange={(e) => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[#B4781E]/50"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.slug})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Folder Selection */}
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-3">
                  Folders to Publish
                </label>
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={selectAllFolders}
                    className="text-xs text-[#B4781E] hover:underline"
                  >
                    Select All
                  </button>
                  <span className="text-[var(--text-tertiary)]">•</span>
                  <button
                    onClick={clearFolders}
                    className="text-xs text-[var(--text-tertiary)] hover:underline"
                  >
                    Clear All
                  </button>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto rounded-xl border border-[var(--border)] p-3 bg-[var(--bg-tertiary)]/30">
                  {folders.length === 0 ? (
                    <p className="text-sm text-[var(--text-tertiary)] text-center py-4">
                      {isProjectScope
                        ? `No folders found in ${activeProject?.name ?? "this project"}`
                        : "No folders found in your vault"}
                    </p>
                  ) : (
                    folders.map((folder) => (
                      <label
                        key={folder}
                        className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedFolders.includes(folder)}
                          onChange={() => toggleFolder(folder)}
                          className="w-4 h-4 rounded border-[var(--border)] text-[#B4781E] focus:ring-[#B4781E] focus:ring-offset-0 bg-[var(--bg-tertiary)]"
                        />
                        <span className="text-sm text-[var(--text-primary)]">
                          {displayName(folder, isProjectScope ? activeProject?.slug ?? null : null)}
                        </span>
                      </label>
                    ))
                  )}
                </div>
                {selectedFolders.length > 0 && (
                  <p className="text-xs text-[var(--text-tertiary)] mt-2">
                    {selectedFolders.length} folder{selectedFolders.length !== 1 ? "s" : ""} selected
                  </p>
                )}
              </div>

              {/* Configuration */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                    Site Title
                  </label>
                  <input
                    type="text"
                    value={config.title}
                    onChange={(e) => setConfig((c) => ({ ...c, title: e.target.value }))}
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[#B4781E]/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                    Brand Name
                  </label>
                  <input
                    type="text"
                    value={config.brand}
                    onChange={(e) => setConfig((c) => ({ ...c, brand: e.target.value }))}
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[#B4781E]/50"
                  />
                </div>
              </div>

              {/* Theme Selection */}
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-3">
                  Theme
                </label>
                <div className="grid grid-cols-3 gap-3">
                  {(["default", "minimal", "api-ref"] as const).map((theme) => (
                    <button
                      key={theme}
                      onClick={() => setConfig((c) => ({ ...c, theme }))}
                      className={`px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all ${
                        config.theme === theme
                          ? "border-[#B4781E] bg-[#B4781E]/10 text-[#B4781E]"
                          : "border-[var(--border)] bg-[var(--bg-tertiary)]/30 text-[var(--text-secondary)] hover:border-[var(--border)]"
                      }`}
                    >
                      {theme.charAt(0).toUpperCase() + theme.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Options */}
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.llmsTxt}
                    onChange={(e) => setConfig((c) => ({ ...c, llmsTxt: e.target.checked }))}
                    className="w-4 h-4 rounded border-[var(--border)] text-[#B4781E] focus:ring-[#B4781E] focus:ring-offset-0 bg-[var(--bg-tertiary)]"
                  />
                  <span className="text-sm text-[var(--text-primary)]">Generate llms.txt</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.seo}
                    onChange={(e) => setConfig((c) => ({ ...c, seo: e.target.checked }))}
                    className="w-4 h-4 rounded border-[var(--border)] text-[#B4781E] focus:ring-[#B4781E] focus:ring-offset-0 bg-[var(--bg-tertiary)]"
                  />
                  <span className="text-sm text-[var(--text-primary)]">SEO Meta Tags</span>
                </label>
              </div>

              {/* Error */}
              {error && (
                <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                  <p className="text-sm text-red-500">{error}</p>
                </div>
              )}

              {/* Success no longer rendered here — bubbled up to a parent toast.
                  Only failures stay in the dialog so the user can fix and retry. */}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)] bg-[var(--bg-tertiary)]/30">
          <button
            onClick={onClose}
            disabled={publishing}
            className="px-4 py-2 rounded-xl text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
          >
            Close
          </button>
          {!isViewMode && selectedFolders.length === 0 && (
            <span
              className="text-xs text-[var(--text-secondary)] italic"
              title="The orange Publish button is disabled until at least one folder is selected"
            >
              Select at least one folder to enable Publish
            </span>
          )}
          {!isViewMode && (
            <button
              onClick={handlePublish}
              disabled={publishing || selectedFolders.length === 0}
              className="px-6 py-2 rounded-xl text-sm font-medium bg-[#B4781E] text-white hover:bg-[#9A6818] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {publishing ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Publishing...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 4h16v16H4z" />
                    <path d="M12 8v8M8 12h8" />
                  </svg>
                  Publish
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
