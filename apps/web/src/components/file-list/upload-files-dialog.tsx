"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { KB_BUCKETS, bucketOf, acceptForFolder, fileFitsFolder, isHtmlResources } from "@/lib/kb-layout";

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

  // KB uploads (no project) must land in one of the four buckets. Compute
  // the bucket-aware view of the folder options and file-input hints.
  const isKb = projectId === "";
  const kbBucket = isKb ? bucketOf(folder) : null;
  const requireFolder = isKb;
  const bucketFilteredFolders = isKb
    ? folderOptions.filter((f) =>
        KB_BUCKETS.some((b) => f === b || f.startsWith(`${b}/`) || f.startsWith(`${b}\\`))
      )
    : folderOptions;
  const acceptAttr = isKb ? acceptForFolder(folder) : null;
  const mismatched = isKb ? files.filter((f) => !fileFitsFolder(f.name, folder)) : [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;
    if (requireFolder && !folder) {
      setError("Pick a KB folder (journal, knowledge, mermaid, or html — or a subfolder).");
      return;
    }
    if (mismatched.length > 0) {
      setError(
        `${mismatched.length} file(s) don't fit ${kbBucket ? kbBucket + "/" : "this folder"}: ${mismatched.map((f) => f.name).join(", ")}`
      );
      return;
    }
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
            <button type="button" onClick={onClose} className="btn btn-icon-md" aria-label="Close dialog">
              <X className="w-4 h-4" aria-hidden />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">FILES</label>
              <input
                type="file"
                multiple
                accept={acceptAttr === null ? ".md,.markdown,.mmd,.html,.htm" : acceptAttr || undefined}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                className="w-full text-sm text-[var(--text-primary)]"
              />
              {isKb && kbBucket && !isHtmlResources(folder) && (
                <p className="text-[10px] text-[var(--text-secondary)] mt-1 italic">
                  {kbBucket}/ accepts {acceptAttr} only. Media goes in html/resources/.
                </p>
              )}
              {files.length > 0 && (
                <ul className="mt-2 text-xs text-[var(--text-secondary)] max-h-32 overflow-auto">
                  {files.map((f, i) => (
                    <li key={i} className="flex items-center justify-between py-0.5">
                      <span className="truncate">{f.name}</span>
                      <button type="button" className="btn btn-icon-sm btn-destructive" aria-label={`Remove ${f.name}`} onClick={() => setFiles((arr) => arr.filter((_, j) => j !== i))}>
                        <X className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">PROJECT</label>
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
                <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">FOLDER</label>
                {isKb && bucketFilteredFolders.length === 0 ? (
                  // Fresh install has no subfolders yet — offer a text input hinting the four bucket names.
                  <>
                    <input
                      type="text"
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      placeholder="e.g. knowledge or journal/2026"
                      list="kb-bucket-hints"
                      className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
                      required
                    />
                    <datalist id="kb-bucket-hints">
                      {KB_BUCKETS.map((b) => <option key={b} value={b} />)}
                    </datalist>
                  </>
                ) : (
                  <select
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
                    required={requireFolder}
                  >
                    {requireFolder ? (
                      <option value="" disabled>— Pick a KB folder —</option>
                    ) : (
                      <option value="">— Root level —</option>
                    )}
                    {bucketFilteredFolders.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">TAGS</label>
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="comma, separated, tags"
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50"
              />
            </div>

            {error && <div className="text-sm text-[var(--danger)]">{error}</div>}

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
