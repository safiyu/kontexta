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

interface PublishResult {
  success: boolean;
  output?: string;
  docCount?: number;
  endpointCount?: number;
  termCount?: number;
  llmsTxt?: string | null;
  error?: string;
}

export function PublishDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
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

  useEffect(() => {
    if (isOpen) {
      fetchFolders();
      setResult(null);
      setError(null);
    }
  }, [isOpen]);

  const fetchFolders = async () => {
    try {
      const res = await fetch("/api/folders/");
      if (res.ok) {
        const data = await res.json();
        setFolders(data.folders || []);
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
        }),
      });

      const data: PublishResult = await res.json();
      setResult(data);

      if (data.success) {
        setTimeout(() => {
          onClose();
        }, 2000);
      } else {
        setError(data.error || "Publish failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed";
      setError(message);
    } finally {
      setPublishing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border)] shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-[#B4781E]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4h16v16H4z" />
              <path d="M9 9h6v6H9z" />
              <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
            </svg>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Publish Documentation</h2>
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
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
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
                  No folders found in your vault
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
                    <span className="text-sm text-[var(--text-primary)]">{folder}</span>
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

          {/* Result */}
          {result && result.success && (
            <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/20 space-y-2">
              <p className="text-sm font-medium text-green-500">Publish successful!</p>
              <div className="text-xs text-[var(--text-secondary)] space-y-1">
                <p>📄 {result.docCount} documents published</p>
                {result.endpointCount !== undefined && (
                  <p>🔗 {result.endpointCount} endpoints indexed</p>
                )}
                {result.termCount !== undefined && (
                  <p>📚 {result.termCount} glossary terms indexed</p>
                )}
                {result.output && (
                  <p>📁 Output: {result.output}</p>
                )}
                {result.llmsTxt && (
                  <p>🤖 llms.txt generated at: {result.llmsTxt}</p>
                )}
              </div>
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
            Cancel
          </button>
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
        </div>
      </div>
    </div>
  );
}
