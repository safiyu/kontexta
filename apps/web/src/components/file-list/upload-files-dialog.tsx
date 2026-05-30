"use client";

import { useState, useEffect } from "react";

interface Project { id: number; name: string }

interface UploadFilesDialogProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultProjectId: number | null;
  defaultFolder: string;
  onUploaded: () => void;
}

interface UploadResponse {
  uploaded: { id: number; original_name: string; final_name: string }[];
  rejected: { name: string; reason: string }[];
}

export function UploadFilesDialog({ open, onClose, projects, defaultProjectId, defaultFolder, onUploaded }: UploadFilesDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [projectId, setProjectId] = useState<number | "">(defaultProjectId ?? "");
  const [folder, setFolder] = useState<string>(defaultFolder);
  const [folderOptions, setFolderOptions] = useState<string[]>([]);
  const [tagsText, setTagsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setProjectId(defaultProjectId ?? "");
      setFolder(defaultFolder);
      setTagsText("");
      setResult(null);
      setError(null);
    }
  }, [open, defaultProjectId, defaultFolder]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = projectId ? `/api/folders?projectId=${projectId}` : `/api/folders`;
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (!cancelled) setFolderOptions(j.folders ?? []);
      } catch {
        if (!cancelled) setFolderOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("project_id", projectId === "" ? "" : String(projectId));
      fd.append("folder", folder);
      const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length) fd.append("tags", JSON.stringify(tags));
      for (const f of files) fd.append("files", f);

      const res = await fetch("/api/files/upload", { method: "POST", body: fd });
      const body = (await res.json()) as UploadResponse | { error: string };
      if (!res.ok) {
        setError((body as { error: string }).error ?? `HTTP ${res.status}`);
      } else {
        setResult(body as UploadResponse);
        onUploaded();
      }
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
            <h3 className="text-lg font-bold text-amber-accent">UPLOAD MARKDOWN FILES</h3>
            <button type="button" onClick={onClose} className="btn btn-icon-md" aria-label="Close dialog">✕</button>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">FILES</label>
              <input
                type="file"
                multiple
                accept=".md,.markdown,.mmd"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                className="w-full text-sm text-[var(--text-primary)]"
              />
              {files.length > 0 && (
                <ul className="mt-2 text-xs text-[var(--text-secondary)] max-h-32 overflow-auto">
                  {files.map((f, i) => (
                    <li key={i} className="flex items-center justify-between py-0.5">
                      <span className="truncate">{f.name}</span>
                      <button type="button" className="btn btn-icon-sm btn-destructive" aria-label={`Remove ${f.name}`} onClick={() => setFiles((arr) => arr.filter((_, j) => j !== i))}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">PROJECT</label>
                <select
                  value={projectId === "" ? "" : String(projectId)}
                  onChange={(e) => setProjectId(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
                >
                  <option value="">— Knowledge Base —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">FOLDER</label>
                <select
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
                >
                  <option value="">— Root level —</option>
                  {folderOptions.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest mb-1.5">TAGS</label>
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="comma, separated, tags"
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
              />
            </div>

            {error && <div className="text-sm text-red-500">{error}</div>}

            {result && (
              <div className="text-sm text-[var(--text-secondary)]">
                Uploaded {result.uploaded.length} · renamed {result.uploaded.filter((u) => u.final_name !== u.original_name).length} · rejected {result.rejected.length}
                {(result.uploaded.some((u) => u.final_name !== u.original_name) || result.rejected.length > 0) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer">Details</summary>
                    <ul className="mt-1 text-xs">
                      {result.uploaded.filter((u) => u.final_name !== u.original_name).map((u, i) => (
                        <li key={`r${i}`}>renamed: {u.original_name} → {u.final_name}</li>
                      ))}
                      {result.rejected.map((r, i) => (
                        <li key={`x${i}`}>rejected: {r.name} ({r.reason})</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-[var(--border-color)] flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-md">Close</button>
            <button
              type="submit"
              disabled={busy || files.length === 0}
              className="btn btn-md"
            >
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
