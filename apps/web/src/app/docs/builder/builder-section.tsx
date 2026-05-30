"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { ToolFormModal, type ToolDef } from "@/components/docs/tool-form-modal";
import { ToolListRow } from "@/components/docs/tool-list-row";
import { TemplateGallery } from "@/components/docs/template-gallery";
import { SaveBar } from "@/components/docs/save-bar";
import { useSearchParams } from "next/navigation";

interface Project { id: number; name: string; path: string; }
interface LoadResp { exists: boolean; raw: string | null; parsed: any; mtimeMs: number | null; parseError?: string; }
interface ValidationResp { tools: Record<string, ToolDef>; disabled: string[]; warnings: string[]; errors: string[]; }

export function BuilderSection() {
  const sp = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [tools, setTools] = useState<Record<string, ToolDef>>({});
  const [mtimeMs, setMtimeMs] = useState<number | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResp | null>(null);
  const [editing, setEditing] = useState<{ name: string; def: ToolDef } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDeleteFile, setConfirmingDeleteFile] = useState(false);
  const [confirmingDeleteTool, setConfirmingDeleteTool] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [initialSnapshot, setInitialSnapshot] = useState<Record<string, ToolDef>>({});

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then((list: Project[]) => {
      setProjects(list);
      const fromUrl = Number(sp.get("project"));
      const initial = (Number.isFinite(fromUrl) && list.find((p) => p.id === fromUrl)) ? fromUrl : list[0]?.id ?? null;
      setProjectId(initial);
    });
  }, [sp]);

  useEffect(() => {
    if (projectId === null) return;
    fetch(`/api/projects/${projectId}/hands-config`).then((r) => r.json()).then((j: LoadResp) => {
      setMtimeMs(j.mtimeMs);
      setParseError(j.parseError ?? null);
      setTools(j.parsed?.tools ?? {});
      setInitialSnapshot(j.parsed?.tools ?? {});
    });
  }, [projectId]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetch("/api/hands/validate", { method: "POST", body: JSON.stringify({ version: "1", tools }) })
        .then((r) => r.json()).then(setValidation).catch(() => {});
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [tools]);

  const unsavedCount = useMemo(() => {
    const initialKeys = new Set(Object.keys(initialSnapshot));
    const currentKeys = new Set(Object.keys(tools));
    let changed = 0;
    for (const k of currentKeys) {
      if (!initialKeys.has(k)) { changed++; continue; }
      if (JSON.stringify(tools[k]) !== JSON.stringify(initialSnapshot[k])) changed++;
    }
    for (const k of initialKeys) if (!currentKeys.has(k)) changed++;
    return changed;
  }, [tools, initialSnapshot]);

  const errorByTool = useMemo(() => {
    const m = new Map<string, string>();
    if (!validation) return m;
    const lines = [...validation.warnings, ...validation.errors];
    for (const line of lines) {
      const match = line.match(/tool '([^']+)'/);
      if (match) m.set(match[1], line);
    }
    return m;
  }, [validation]);

  const errorCount = (validation?.errors.length ?? 0) + errorByTool.size;

  const onSaveTool = (name: string, def: ToolDef) => {
    setTools((cur) => {
      const next: Record<string, ToolDef> = {};
      // preserve order: replace if editing same name, else append
      for (const [n, d] of Object.entries(cur)) {
        if (editing && n === editing.name) next[name] = def;
        else next[n] = d;
      }
      if (!editing || !(editing.name in cur)) next[name] = def;
      return next;
    });
    setModalOpen(false);
    setEditing(null);
  };

  const onDelete = (name: string) => {
    setConfirmingDeleteTool(name);
  };

  const performDeleteTool = () => {
    const name = confirmingDeleteTool;
    if (!name) return;
    setTools((cur) => { const { [name]: _, ...rest } = cur; return rest; });
    setConfirmingDeleteTool(null);
  };

  const performDeleteFile = async () => {
    if (projectId === null) return;
    setConfirmingDeleteFile(false);
    setSaveError(null);
    const res = await fetch(`/api/projects/${projectId}/hands-config`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setSaveError(j.error || `Delete failed: HTTP ${res.status}`);
      return;
    }
    setTools({});
    setInitialSnapshot({});
    setMtimeMs(null);
    setParseError(null);
  };

  const onSaveFile = async () => {
    if (projectId === null) return;
    setSaveError(null);
    const res = await fetch(`/api/projects/${projectId}/hands-config`, {
      method: "PUT",
      body: JSON.stringify({ config: { version: "1", tools }, ifMtimeMs: mtimeMs }),
    });
    if (res.status === 409) {
      const body = await res.json();
      if (window.confirm("kontexta.json changed on disk. Overwrite?")) {
        const retry = await fetch(`/api/projects/${projectId}/hands-config`, {
          method: "PUT",
          body: JSON.stringify({ config: { version: "1", tools }, ifMtimeMs: body.currentMtimeMs }),
        });
        if (retry.ok) {
          const j = await retry.json();
          setMtimeMs(j.mtimeMs);
          setInitialSnapshot({ ...tools });
        } else {
          const j = await retry.json().catch(() => ({}));
          setSaveError(`Retry failed: ${j.error || (j.errors ?? []).join("; ") || `HTTP ${retry.status}`}`);
        }
      }
      return;
    }
    if (res.ok) {
      const j = await res.json();
      setMtimeMs(j.mtimeMs);
      setInitialSnapshot({ ...tools });
      return;
    }
    const j = await res.json().catch(() => ({}));
    setSaveError(j.error || (j.errors ?? []).join("; ") || `Save failed: HTTP ${res.status}`);
  };

  if (projects.length === 0) {
    return <div className="max-w-2xl mx-auto text-sm">No projects registered. <a href="/" className="underline">Register one first</a>.</div>;
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-end justify-between mb-4 gap-3">
        <label className="flex flex-col text-xs">
          <span className="mb-1 text-[var(--text-secondary)]">Project</span>
          <select
            value={projectId ?? ""}
            onChange={(e) => setProjectId(Number(e.target.value))}
            aria-label="project"
            className="px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded min-w-[200px]"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {mtimeMs !== null && (
          <button
            onClick={() => setConfirmingDeleteFile(true)}
            className="text-xs text-red-500 hover:underline focus:underline"
            title="Remove kontexta.json from this project"
          >
            Delete kontexta.json
          </button>
        )}
      </div>

      {parseError && (
        <div className="mb-3 p-3 border border-red-500 rounded text-sm text-red-500">
          kontexta.json failed to parse: {parseError}. Fix the file manually before continuing.
        </div>
      )}
      {saveError && (
        <div className="mb-3 p-3 border border-red-500 rounded text-sm text-red-500">
          {saveError}
        </div>
      )}

      {Object.entries(tools).map(([name, def]) => (
        <ToolListRow key={name} name={name} def={def}
          onEdit={() => { setEditing({ name, def }); setModalOpen(true); }}
          onDelete={() => onDelete(name)}
          errorBadge={errorByTool.get(name) ?? null}
        />
      ))}

      {Object.keys(tools).length > 0 && (
        <button
          onClick={() => { setEditing(null); setModalOpen(true); }}
          className="w-full mt-2 px-3 py-2 text-sm border border-dashed border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black"
        >
          + Add tool
        </button>
      )}

      {Object.keys(tools).length === 0 && !parseError && (
        <TemplateGallery
          onSelectTemplate={(name, def) => {
            setEditing({ name, def });
            setModalOpen(true);
          }}
          onBlank={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        />
      )}

      {modalOpen && (
        <ToolFormModal
          open
          initial={editing}
          projectName={projects.find((p) => p.id === projectId)?.name}
          onSave={onSaveTool}
          onClose={() => { setModalOpen(false); setEditing(null); }}
        />
      )}

      <SaveBar
        count={unsavedCount}
        errorCount={errorCount}
        onDiscard={() => {
          setTools({ ...initialSnapshot });
          setSaveError(null);
        }}
        onSave={onSaveFile}
      />

      {confirmingDeleteTool !== null && typeof document !== "undefined" && createPortal(
        <div
          role="dialog"
          aria-label={`Confirm delete tool ${confirmingDeleteTool}`}
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={(e) => e.target === e.currentTarget && setConfirmingDeleteTool(null)}
        >
          <div className="w-[480px] bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg p-5 shadow-2xl space-y-4">
            <h2 className="text-lg font-semibold">Delete tool &ldquo;{confirmingDeleteTool}&rdquo;?</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              This removes the tool from kontexta.json. The change is staged locally — click Save to persist.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <button
                onClick={() => setConfirmingDeleteTool(null)}
                className="px-3 py-1 text-sm border border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black"
              >
                Cancel
              </button>
              <button
                onClick={performDeleteTool}
                className="px-3 py-1 text-sm border border-red-500 rounded text-red-500 transition hover:bg-red-500 hover:text-white focus:bg-red-500 focus:text-white"
              >
                Delete tool
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {confirmingDeleteFile && typeof document !== "undefined" && createPortal(
        <div
          role="dialog"
          aria-label="Confirm delete kontexta.json"
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={(e) => e.target === e.currentTarget && setConfirmingDeleteFile(false)}
        >
          <div className="w-[480px] bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg p-5 shadow-2xl space-y-4">
            <h2 className="text-lg font-semibold">Delete kontexta.json?</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              This removes the kontexta.json file from this project. All declared Hands tools will be unregistered. This cannot be undone unless the project has git history.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <button
                onClick={() => setConfirmingDeleteFile(false)}
                className="px-3 py-1 text-sm border border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black"
              >
                Cancel
              </button>
              <button
                onClick={performDeleteFile}
                className="px-3 py-1 text-sm border border-red-500 rounded text-red-500 transition hover:bg-red-500 hover:text-white focus:bg-red-500 focus:text-white"
              >
                Delete kontexta.json
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
