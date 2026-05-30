"use client";

import { useState, useEffect } from "react";

interface NewFileDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string, content: string, destination: "knowledge" | "project" | "kontexta", folder?: string) => Promise<void>;
  currentProjectId: number | null;
  availableFolders: string[];
}

export function NewFileDialog({ open, onClose, onCreate, currentProjectId, availableFolders }: NewFileDialogProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [folder, setFolder] = useState("");
  const [destination, setDestination] = useState<"knowledge" | "project" | "kontexta">(
    currentProjectId ? "project" : "knowledge"
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setDestination(currentProjectId ? "project" : "knowledge");
      setFolder("");
    }
  }, [open, currentProjectId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    try {
      await onCreate(title, content, destination, folder || undefined);
      setTitle("");
      setContent("");
      setFolder("");
      onClose();
    } catch (error) {
      console.error("Failed to create file:", error);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="w-[600px] bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-2xl overflow-hidden">
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 border-b border-[var(--border-color)] flex items-center justify-between">
            <h3 className="text-lg font-bold text-amber-accent">CREATE NEW CONTEXT</h3>
            <button type="button" onClick={onClose} className="btn btn-icon-md" aria-label="Close dialog">✕</button>
          </div>

          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">TITLE</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Architecture Overview"
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">
                  FOLDER
                </label>
                {availableFolders.length > 0 ? (
                  <select
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
                  >
                    <option value="">— Root level —</option>
                    {availableFolders.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="No folders yet — type to create"
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
                  />
                )}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">DESTINATION</label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setDestination("knowledge")}
                  className={`btn btn-sm flex-1 ${destination === "knowledge" ? "border-[var(--accent)]" : ""}`}
                >
                  KNOWLEDGE BASE
                </button>
                {currentProjectId && (
                  <button
                    type="button"
                    onClick={() => setDestination("project")}
                    className={`btn btn-sm flex-1 ${destination === "project" ? "border-[var(--accent)]" : ""}`}
                  >
                    PROJECT ROOT
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">CONTENT (MARKDOWN)</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={"# Introduction\nStart typing here..."}
                rows={8}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 font-mono resize-none"
              />
            </div>
          </div>

          <div className="px-6 py-4 bg-[var(--bg-secondary)]/50 border-t border-[var(--border-color)] flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-md"
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim()}
              className="btn btn-md"
            >
              {loading ? "CREATING..." : "CREATE FILE"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
