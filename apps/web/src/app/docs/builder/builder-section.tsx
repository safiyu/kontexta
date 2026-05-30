"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { ToolForm, type ToolDef } from "@/components/docs/tool-form";
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

  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDeleteFile, setConfirmingDeleteFile] = useState(false);
  const [confirmingDeleteTool, setConfirmingDeleteTool] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [templatesCollapsed, setTemplatesCollapsed] = useState(true);
  const [initialSnapshot, setInitialSnapshot] = useState<Record<string, ToolDef>>({});

  useEffect(() => {
    if (Object.keys(tools).length === 0) setTemplatesCollapsed(false);
  }, [Object.keys(tools).length === 0]);

  useEffect(() => {
    fetch("/api/projects")
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((list: Project[]) => {
        setProjects(list);
        const fromUrl = sp.get("project");
        const fromUrlId = fromUrl ? Number(fromUrl) : NaN;
        const initial = (!isNaN(fromUrlId) && list.find((p) => p.id === fromUrlId)) ? fromUrlId : list[0]?.id ?? null;
        setProjectId(initial);
      })
      .catch((err) => {
        console.error("Failed to load projects:", err);
        setSaveError(`Failed to load projects: ${err.message}`);
      });
  }, [sp]);

  useEffect(() => {
    if (projectId === null) return;
    fetch(`/api/projects/${projectId}/hands-config`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: LoadResp) => {
        setMtimeMs(j.mtimeMs);
        setParseError(j.parseError ?? null);
        const t = j.parsed?.tools ?? {};
        setTools(t);
        setInitialSnapshot(t);
        if (Object.keys(t).length > 0) setTemplatesCollapsed(true);
      })
      .catch((err) => {
        console.error("Failed to load hands-config:", err);
        setSaveError(`Failed to load project configuration: ${err.message}`);
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
    setTemplatesCollapsed(false);
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

  const hasTools = Object.keys(tools).length > 0;
  const selectedTool = editing || (Object.keys(tools).length > 0 ? { name: Object.keys(tools)[0], def: tools[Object.keys(tools)[0]] } : null);

  return (
    <div className="flex flex-col h-full -m-6 overflow-hidden bg-[var(--bg-primary)]">
      {/* Top Bar: Project Selector & Save */}
      <div className="flex items-center justify-between px-6 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border)] shadow-sm z-10">
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-3 text-xs font-bold uppercase tracking-widest text-[var(--text-secondary)]">
            Project
            <select
              value={projectId ?? ""}
              onChange={(e) => setProjectId(Number(e.target.value))}
              aria-label="project"
              className="px-3 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg font-mono text-[var(--accent)] outline-none focus:border-[var(--accent)] transition-all cursor-pointer min-w-[220px]"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          
          {mtimeMs !== null && (
            <button
              onClick={() => setConfirmingDeleteFile(true)}
              className="text-[10px] font-bold uppercase tracking-widest text-red-500/70 hover:text-red-500 transition-colors"
              title="Remove kontexta.json from this project"
            >
              Delete Config
            </button>
          )}
        </div>

        <SaveBar
          inline
          count={unsavedCount}
          errorCount={errorCount}
          onDiscard={() => {
            setTools({ ...initialSnapshot });
            setSaveError(null);
          }}
          onSave={onSaveFile}
        />
      </div>

      {/* Main 3-Pane Explorer */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Pane: Tools Registry */}
        <div className="w-[300px] flex flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]/30">
          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between bg-[var(--bg-secondary)]/50">
            <h4 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
              Registry
            </h4>
            <button
              onClick={() => { setEditing({ name: "", def: { description: "", command: [], params: {}, danger: "safe" } }); }}
              className="p-1 rounded hover:bg-[var(--accent)] hover:text-black transition-colors"
              title="Add tool from scratch"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
            {Object.entries(tools).map(([name, def]) => (
              <div
                key={name}
                role="button"
                tabIndex={0}
                onClick={() => setEditing({ name, def })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing({ name, def }); } }}
                className={`w-full group flex items-center justify-between px-3 py-2 rounded-lg transition-all border cursor-pointer outline-none focus:ring-1 focus:ring-[var(--accent)] ${
                  editing?.name === name 
                    ? "bg-[var(--accent)] text-black border-transparent shadow-lg" 
                    : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--accent)]/10 hover:text-[var(--text-primary)]"
                }`}
              >
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${editing?.name === name ? "bg-black" : "bg-[var(--accent)]"}`} />
                  <span className="font-mono text-[13px] truncate">{name}</span>
                </div>
                
                <div className="flex items-center gap-2">
                  {errorByTool.has(name) && (
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" title={errorByTool.get(name)} />
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(name); }}
                    className={`opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500 hover:text-white transition-all ${editing?.name === name ? "text-black hover:bg-black/20" : ""}`}
                    title="Delete tool"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
            
            {!hasTools && (
              <div className="text-center py-8 px-4 text-xs text-[var(--text-secondary)] italic border border-dashed border-[var(--border)] rounded-xl m-2">
                No tools defined yet.
              </div>
            )}
          </div>
        </div>

        {/* Middle Pane: Tool Editor */}
        <div className="flex-1 overflow-y-auto bg-[var(--bg-primary)] custom-scrollbar relative border-r border-[var(--border)]">
          {parseError && (
            <div className="m-6 p-4 bg-red-500/10 border border-red-500/50 rounded-xl text-sm text-red-500 animate-fade-in">
              <span className="font-bold block mb-1">Configuration Error</span>
              kontexta.json failed to parse: {parseError}. Fix the file manually before continuing.
            </div>
          )}
          {saveError && (
            <div className="m-6 p-4 bg-red-500/10 border border-red-500/50 rounded-xl text-sm text-red-500 animate-fade-in">
              {saveError}
              <button onClick={() => setSaveError(null)} className="ml-2 text-red-500 hover:text-red-400">✕</button>
            </div>
          )}

          <div className="p-8 max-w-4xl mx-auto">
            {editing ? (
              <div key={editing.name || "new-tool"} className="animate-fade-in">
                <header className="mb-8 border-b border-[var(--border)] pb-6">
                  <div className="inline-flex items-center px-2 py-0.5 rounded bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-[var(--accent)] text-[10px] font-bold uppercase tracking-wider mb-3">
                    {editing.name ? "Editor" : "New Tool"}
                  </div>
                  <h3 className="text-3xl font-title font-extrabold text-[var(--text-primary)] tracking-tight">
                    {editing.name || "Untitled Tool"}
                  </h3>
                </header>
                
                <ToolForm 
                  inline
                  initial={editing}
                  projectName={projects.find((p) => p.id === projectId)?.name}
                  onSave={onSaveTool}
                />
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center py-20 animate-fade-in">
                <div className="w-16 h-16 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center mb-6 border border-[var(--border)]">
                  <svg className="w-8 h-8 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
                  </svg>
                </div>
                <h3 className="text-xl font-bold text-[var(--text-primary)] mb-2">Configure Your Tools</h3>
                <p className="text-sm text-[var(--text-secondary)] max-w-xs mx-auto">
                  Select an existing tool to edit, or use the <strong>Start from scratch</strong> button on the right to create a new one.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Pane: Gallery */}
        <div className={`bg-[var(--bg-secondary)]/30 border-l border-[var(--border)] transition-all duration-300 flex flex-col ${templatesCollapsed ? "w-[48px]" : "w-[350px]"}`}>
          <button
            onClick={() => setTemplatesCollapsed(!templatesCollapsed)}
            className="p-4 border-b border-[var(--border)] flex items-center justify-center hover:bg-[var(--accent)] hover:text-black transition-colors group"
            title={templatesCollapsed ? "Expand Template Gallery" : "Collapse Template Gallery"}
          >
            {templatesCollapsed ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
              </svg>
            ) : (
              <div className="flex items-center gap-3 w-full">
                <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-[10px] font-bold uppercase tracking-widest truncate">Template Gallery</span>
              </div>
            )}
          </button>

          {!templatesCollapsed && (
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <TemplateGallery
                heading={hasTools ? "Add from template:" : "Start with a template:"}
                onSelectTemplate={(name, def) => {
                  setEditing({ name, def });
                }}
                onBlank={() => {
                  setEditing({ name: "", def: { description: "", command: [], params: {}, danger: "safe" } });
                }}
              />
            </div>
          )}
        </div>
      </div>


      {confirmingDeleteTool !== null && typeof document !== "undefined" && createPortal(
        <div
          role="dialog"
          aria-label={`Confirm delete tool ${confirmingDeleteTool}`}
          className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4 animate-fade-in"
          onClick={(e) => e.target === e.currentTarget && setConfirmingDeleteTool(null)}
        >
          <div className="w-full max-w-md bg-[var(--bg-primary)] border border-[var(--border)] rounded-2xl p-6 shadow-2xl space-y-6">
            <div>
              <h2 className="text-xl font-bold mb-2 text-[var(--text-primary)]">Delete tool &ldquo;{confirmingDeleteTool}&rdquo;?</h2>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                This removes the tool definition from your <code>kontexta.json</code>. The change is staged — click **Save** in the top bar to persist.
              </p>
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border)]">
              <button
                onClick={() => setConfirmingDeleteTool(null)}
                className="px-4 py-2 text-sm font-bold border border-[var(--border)] rounded-lg hover:bg-[var(--bg-secondary)] transition-all"
              >
                Cancel
              </button>
              <button
                onClick={performDeleteTool}
                className="px-4 py-2 text-sm font-bold bg-red-500 text-white rounded-lg hover:bg-red-600 shadow-lg shadow-red-500/20 transition-all"
              >
                Delete Tool
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
          className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4 animate-fade-in"
          onClick={(e) => e.target === e.currentTarget && setConfirmingDeleteFile(false)}
        >
          <div className="w-full max-w-md bg-[var(--bg-primary)] border border-[var(--border)] rounded-2xl p-6 shadow-2xl space-y-6">
            <div>
              <h2 className="text-xl font-bold mb-2 text-[var(--text-primary)]">Delete kontexta.json?</h2>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                This removes the configuration file from this project. All Hands tools will be unregistered immediately.
              </p>
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border)]">
              <button
                onClick={() => setConfirmingDeleteFile(false)}
                className="px-4 py-2 text-sm font-bold border border-[var(--border)] rounded-lg hover:bg-[var(--bg-secondary)] transition-all"
              >
                Cancel
              </button>
              <button
                onClick={performDeleteFile}
                className="px-4 py-2 text-sm font-bold bg-red-500 text-white rounded-lg hover:bg-red-600 shadow-lg shadow-red-500/20 transition-all"
              >
                Delete File
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
