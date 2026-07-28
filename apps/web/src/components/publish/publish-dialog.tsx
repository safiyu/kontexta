"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog } from "@/components/ui/dialog";

interface PublishConfig {
  folders: string[];
  title: string;
  brand: string;
  tagline: string;
  hero: boolean;
  theme: "default" | "minimal" | "api-ref" | "flat" | "terminal" | "paper" | "solarized" | "brutalist" | "ocean";
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

type ThemeKey = PublishConfig["theme"];

/** "Just now" / "5m ago" / "3h ago" / "2d ago" / absolute date if older than a week. */
function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Theme options shown in the picker, with a 4-swatch preview pulled from
 *  the theme's CSS (accent + the three main bg/text colors). */
const THEME_OPTIONS: { key: ThemeKey; label: string; swatches: string[] }[] = [
  { key: "default", label: "Default", swatches: ["#B4781E", "#1a1a1a", "#e5e5e5", "#252525"] },
  { key: "minimal", label: "Minimal", swatches: ["#2563eb", "#ffffff", "#1a1a1a", "#e0e0e0"] },
  { key: "api-ref", label: "API Ref", swatches: ["#0ea5e9", "#0c1222", "#e2e8f0", "#1e293b"] },
  { key: "flat", label: "Flat", swatches: ["#e91e63", "#00bcd4", "#ff9800", "#9c27b0"] },
  { key: "terminal", label: "Terminal", swatches: ["#00ff41", "#000000", "#33cc33", "#1a3a1a"] },
  { key: "paper", label: "Paper", swatches: ["#8b4513", "#faf6f1", "#2b2620", "#d9cdb8"] },
  { key: "solarized", label: "Solarized", swatches: ["#b58900", "#268bd2", "#2aa198", "#dc322f"] },
  { key: "brutalist", label: "Brutalist", swatches: ["#000000", "#ffff00", "#ffffff", "#555555"] },
  { key: "ocean", label: "Ocean", swatches: ["#5eead4", "#c4b5fd", "#fda4af", "#0b1220"] },
];

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
    tagline: "",
    hero: true,
    theme: "default",
    llmsTxt: true,
    seo: true,
  });
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewExists, setViewExists] = useState(false);
  const [lastBuilt, setLastBuilt] = useState<string | null>(null);

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
        fetchLastBuilt();
      }
      setResult(null);
      setError(null);
    }
  }, [isOpen, mode]);

  const fetchLastBuilt = async () => {
    try {
      const res = await fetch("/api/publish");
      if (res.ok) {
        const data = await res.json();
        setLastBuilt(data?.lastBuilt ?? null);
      }
    } catch { /* swallow — footer line just won't render */ }
  };

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
          tagline: config.tagline,
          hero: config.hero,
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

  const isProjectScope = selectedProjectId !== null;
  const activeProject = projects.find((p) => p.id === selectedProjectId);
  const isViewMode = mode === "view";

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={isViewMode ? "View published site" : "Publish documentation"}
      widthClass={isViewMode ? "max-w-[1400px]" : "max-w-2xl"}
      hideHeader
    >
      <div className="-m-5 flex flex-col max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-[#B4781E]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4h16v16H4z" />
              <path d="M9 9h6v6H9z" />
              <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
            </svg>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              {isViewMode ? "View published site" : "Publish documentation"}
            </h2>
          </div>
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

              {/* Hero toggle + tagline */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input
                    type="checkbox"
                    checked={config.hero}
                    onChange={(e) => setConfig((c) => ({ ...c, hero: e.target.checked }))}
                    className="w-4 h-4 rounded border-[var(--border)] text-[#B4781E] focus:ring-[#B4781E] focus:ring-offset-0 bg-[var(--bg-tertiary)]"
                  />
                  <span className="text-sm font-medium text-[var(--text-secondary)]">
                    Show hero on landing page
                  </span>
                </label>
                {config.hero && (
                  <input
                    type="text"
                    value={config.tagline}
                    onChange={(e) => setConfig((c) => ({ ...c, tagline: e.target.value }))}
                    placeholder="Optional tagline shown under the title"
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[#B4781E]/50"
                  />
                )}
              </div>

              {/* Theme Selection */}
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-3">
                  Theme
                </label>
                <div className="grid grid-cols-3 gap-3">
                  {THEME_OPTIONS.map(({ key, label, swatches }) => (
                    <button
                      key={key}
                      onClick={() => setConfig((c) => ({ ...c, theme: key }))}
                      className={`px-3 py-3 rounded-xl border-2 text-sm font-medium transition-all flex flex-col items-start gap-2 ${
                        config.theme === key
                          ? "border-[#B4781E] bg-[#B4781E]/10 text-[#B4781E]"
                          : "border-[var(--border)] bg-[var(--bg-tertiary)]/30 text-[var(--text-secondary)] hover:border-[var(--border)]"
                      }`}
                    >
                      <span>{label}</span>
                      <span className="flex gap-1">
                        {swatches.map((c, i) => (
                          <span
                            key={i}
                            className="w-3 h-3 rounded-full border border-black/10"
                            style={{ background: c }}
                          />
                        ))}
                      </span>
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
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[var(--border)] bg-[var(--bg-tertiary)]/30">
          <div className="text-xs text-[var(--text-secondary)] flex-1">
            {!isViewMode && lastBuilt && (
              <span title={new Date(lastBuilt).toLocaleString()}>
                Last built {formatRelative(lastBuilt)}
              </span>
            )}
          </div>
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
    </Dialog>
  );
}
