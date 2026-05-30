"use client";

import { useState, useEffect } from "react";

interface ClipUrlDialogProps {
  open: boolean;
  onClose: () => void;
  onClipped: () => void;
}

export function ClipUrlDialog({ open, onClose, onClipped }: ClipUrlDialogProps) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl("");
      setTitle("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), title: title.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      onClipped();
      onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="w-[600px] bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-2xl overflow-hidden">
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 border-b border-[var(--border-color)] flex items-center justify-between">
            <h3 className="text-lg font-bold text-amber-accent">CLIP URL</h3>
            <button type="button" onClick={onClose} className="btn btn-icon-md" aria-label="Close dialog">✕</button>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">URL</label>
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/article"
                disabled={busy}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">TITLE (OPTIONAL)</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to page title"
                disabled={busy}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
              />
            </div>

            {error && <div className="text-sm text-red-500">{error}</div>}
          </div>

          <div className="px-6 py-4 border-t border-[var(--border-color)] flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-md">Close</button>
            <button
              type="submit"
              disabled={busy || !url.trim()}
              className="btn btn-md"
            >
              {busy ? "Clipping…" : "Clip"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
