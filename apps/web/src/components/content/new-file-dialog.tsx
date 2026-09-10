"use client";

import { useState, useEffect, useRef } from "react";
import { Dialog } from "../ui/dialog";
import { KB_BUCKETS, bucketOf, formatForFolder, isHtmlResources, type KbFormat } from "@/lib/kb-layout";

type NewFileKind = "dictionary" | "note";

interface NewFileDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string, content: string, destination: "knowledge" | "project" | "kontexta", folder?: string, format?: KbFormat, kind?: NewFileKind) => Promise<boolean>;
  currentProjectId: number | null;
  availableFolders: string[];
  /** Preselected folder (from the tree). Empty string / undefined = pick manually. */
  defaultFolder?: string;
}

function inferKindFromFolder(f: string): NewFileKind | null {
  const norm = f.replace(/^\/+|\/+$/g, "");
  if (norm.startsWith("knowledge/dictionary") || norm.startsWith("knowledge/urlclips")) return "dictionary";
  if (norm.startsWith("knowledge/notes")) return "note";
  return null;
}

export function NewFileDialog({ open, onClose, onCreate, currentProjectId, availableFolders, defaultFolder }: NewFileDialogProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [folder, setFolder] = useState("");
  const [destination, setDestination] = useState<"knowledge" | "project" | "kontexta">(
    currentProjectId ? "project" : "knowledge"
  );
  const [format, setFormat] = useState<KbFormat>("md");
  const [kind, setKind] = useState<NewFileKind | null>(null);
  const [loading, setLoading] = useState(false);

  // Reset only on false→true transition — defaultFolder can change mid-open without wiping user input.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const initialDest = currentProjectId ? "project" : "knowledge";
      setDestination(initialDest);
      const initialFolder = initialDest === "knowledge" ? (defaultFolder ?? "") : "";
      setFolder(initialFolder);
      const inferred = initialDest === "knowledge" ? formatForFolder(initialFolder) : null;
      setFormat(inferred ?? "md");
      setKind(initialDest === "knowledge" ? inferKindFromFolder(initialFolder) : null);
      setTitle("");
      setContent("");
    }
    prevOpenRef.current = open;
  }, [open, currentProjectId, defaultFolder]);

  // Whenever folder changes on the KB side, keep kind in sync if the folder
  // already carries a class hint. Doesn't clobber an existing kind choice
  // when the folder is class-neutral.
  useEffect(() => {
    if (destination !== "knowledge") return;
    const inferred = inferKindFromFolder(folder);
    if (inferred) setKind(inferred);
  }, [folder, destination]);

  // Whenever the folder changes (KB destination only), realign the format so
  // the user doesn't accidentally write `.mmd` into `journal/`.
  useEffect(() => {
    if (destination !== "knowledge") return;
    const inferred = formatForFolder(folder);
    if (inferred) setFormat(inferred);
  }, [folder, destination]);

  const isKb = destination === "knowledge";
  const kbBucket = isKb ? bucketOf(folder) : null;
  const formatLocked = isKb && kbBucket !== null && !isHtmlResources(folder);
  // Bucket-scoped folder suggestions: keep KB users out of legacy folders.
  const suggestedFolders = isKb
    ? availableFolders.filter((f) => KB_BUCKETS.some((b) => f === b || f.startsWith(`${b}/`) || f.startsWith(`${b}\\`)))
    : availableFolders;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (isKb && !kind) return;
    setLoading(true);
    try {
      const created = await onCreate(title, content, destination, folder || undefined, format, isKb ? (kind ?? undefined) : undefined);
      if (created) {
        setTitle("");
        setContent("");
        setFolder("");
        setKind(null);
        onClose();
      }
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
              {suggestedFolders.length > 0 ? (
                <select
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
                  required={isKb}
                >
                  {!isKb && <option value="">— Root level —</option>}
                  {isKb && <option value="" disabled>— Pick a folder —</option>}
                  {suggestedFolders.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder={isKb ? "e.g. knowledge/topic" : "No folders yet — type to create"}
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

          {isKb && (
            <div>
              <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">
                CONTENT CLASS <span className="text-red-500 font-normal normal-case tracking-normal">*</span>
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setKind("dictionary")}
                  className={`btn btn-sm flex-1 ${kind === "dictionary" ? "border-[var(--accent)]" : ""}`}
                  title="Authoritative — system IDs, mappings, glossaries. Trusted over notes."
                >
                  DICTIONARY
                </button>
                <button
                  type="button"
                  onClick={() => setKind("note")}
                  className={`btn btn-sm flex-1 ${kind === "note" ? "border-[var(--accent)]" : ""}`}
                  title="Informational — meeting notes, working thoughts, current-state write-ups."
                >
                  NOTE
                </button>
              </div>
              {!kind && (
                <p className="text-[10px] text-red-500 mt-1">Required — pick dictionary (authoritative) or note (informational).</p>
              )}
            </div>
          )}

          {isKb && (
            <div>
              <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">
                FORMAT{formatLocked && <span className="ml-2 text-[var(--text-secondary)] font-normal normal-case tracking-normal italic">— fixed by {kbBucket}/</span>}
              </label>
              <div className="flex gap-3">
                {(["md", "mmd", "html"] as const).map((f) => {
                  const active = format === f;
                  const disabled = formatLocked && !active;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => !disabled && setFormat(f)}
                      disabled={disabled}
                      title={disabled ? `Not allowed in ${kbBucket}/` : undefined}
                      className={`btn btn-sm flex-1 ${active ? "border-[var(--accent)]" : ""} ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
                    >
                      .{f}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-[10px] font-bold text-[var(--text-secondary)] tracking-widest mb-1.5">
              CONTENT ({format === "html" ? "HTML" : format === "mmd" ? "MERMAID" : "MARKDOWN"})
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                format === "html"
                  ? "<h1>Report</h1>"
                  : format === "mmd"
                    ? "graph TD\n  A --> B"
                    : "# Introduction\nStart typing here..."
              }
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
            disabled={loading || !title.trim() || (isKb && (!folder || !kind))}
            className="btn btn-md"
          >
            {loading ? "CREATING..." : "CREATE FILE"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
