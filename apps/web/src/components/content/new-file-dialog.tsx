"use client";

import { useState, useEffect } from "react";
import { Dialog } from "../ui/dialog";

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
      setTitle("");
      setContent("");
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

  return (
    <Dialog open={open} onClose={onClose} title="New file" widthClass="max-w-lg">
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">TITLE</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Architecture Overview"
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">
                FOLDER
              </label>
              {availableFolders.length > 0 ? (
                <select
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
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
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
                />
              )}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">DESTINATION</label>
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
            <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">CONTENT (MARKDOWN)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={"# Introduction\nStart typing here..."}
              rows={8}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 font-mono resize-none"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-5">
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
    </Dialog>
  );
}
