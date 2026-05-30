"use client";

import { useState, useEffect } from "react";
import { ArgvChipEditor } from "./argv-chip-editor";
import { ParamEditor, type ParamDef } from "./param-editor";

export interface ToolDef {
  description: string;
  command: string[];
  workingDir?: string;
  timeout?: number;
  danger?: "safe" | "moderate" | "high";
  confirm?: boolean;
  disabled?: boolean;
  argSeparator?: boolean;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  params?: Record<string, ParamDef>;
}

export const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface ToolFormProps {
  initial: { name: string; def: ToolDef } | null;
  projectName?: string;
  onSave: (name: string, def: ToolDef) => void;
  onCancel?: () => void;
  inline?: boolean;
}

export function ToolForm({ initial, projectName, onSave, onCancel, inline }: ToolFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [def, setDef] = useState<ToolDef>(() => {
    const d = initial?.def ?? { description: "", command: [] };
    if (!Array.isArray(d.command)) d.command = [];
    return d;
  });

  // Sync state if initial changes (important for inline editor switching)
  useEffect(() => {
    setName(initial?.name ?? "");
    const d = initial?.def ?? { description: "", command: [] };
    if (!Array.isArray(d.command)) d.command = [];
    setDef(d);
  }, [initial]);

  const declaredParams = Object.keys(def.params ?? {});
  const isValid =
    NAME_RE.test(name) &&
    def.description.trim().length > 0 &&
    def.command.length > 0 &&
    !def.command[0].includes("{{");

  const setParams = (mut: (p: Record<string, ParamDef>) => Record<string, ParamDef>) =>
    setDef({ ...def, params: mut({ ...(def.params ?? {}) }) });

  const containerClasses = inline 
    ? "space-y-6" 
    : "space-y-4";

  return (
    <div className={containerClasses}>
      {!inline && <h2 className="text-lg font-semibold">{initial ? "Edit tool" : "Add tool"}</h2>}

      <div className="grid gap-6">
        <section className="space-y-4">
          <label className="block text-xs">
            <span className="text-[var(--text-secondary)] font-bold uppercase tracking-wider">Tool name</span>
            <input
              aria-label="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. run-tests"
              className="w-full mt-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg font-mono focus:border-[var(--accent)] outline-none transition"
            />
            <span className="block text-[10px] text-[var(--text-secondary)] mt-1.5 leading-relaxed">
              Lowercase letters, digits, hyphens. Kontexta namespaces it automatically — the agent sees{" "}
              <code className="text-[var(--accent)]">
                {(projectName ?? "<project>")}__{name || "<name>"}
              </code>
            </span>
            {name && !NAME_RE.test(name) && <span className="text-red-500 text-[10px]">must match ^[a-z][a-z0-9-]*$</span>}
          </label>

          <label className="block text-xs">
            <span className="text-[var(--text-secondary)] font-bold uppercase tracking-wider">Description</span>
            <input 
              aria-label="description" 
              value={def.description} 
              onChange={(e) => setDef({ ...def, description: e.target.value })} 
              className="w-full mt-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus:border-[var(--accent)] outline-none transition" 
              placeholder="Describe what this tool does..."
            />
            <span className="block text-[10px] text-[var(--text-secondary)] mt-1.5 leading-relaxed">
              What the agent sees when deciding whether to call this tool. Be specific.
            </span>
          </label>
        </section>

        <section className="space-y-3">
          <span className="text-[var(--text-secondary)] text-xs font-bold uppercase tracking-wider">Command argv</span>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
            <ArgvChipEditor value={def.command} onChange={(v) => setDef({ ...def, command: v })} declaredParams={declaredParams} />
          </div>
          <span className="block text-[10px] text-[var(--text-secondary)] leading-relaxed">
            argv passed to <code>spawn</code> (no shell). argv[0] is the executable. Subsequent items can use <code>{"{{paramName}}"}</code>.
          </span>
        </section>

        <section className="grid grid-cols-3 gap-4">
          <label className="text-xs">
            <span className="text-[var(--text-secondary)] font-bold uppercase tracking-wider">Timeout (ms)</span>
            <input 
              type="number" 
              value={def.timeout ?? ""} 
              onChange={(e) => setDef({ ...def, timeout: e.target.value === "" ? undefined : Number(e.target.value) })} 
              className="w-full mt-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus:border-[var(--accent)] outline-none transition" 
              placeholder="60000" 
            />
          </label>
          <label className="text-xs">
            <span className="text-[var(--text-secondary)] font-bold uppercase tracking-wider">Max output</span>
            <input 
              type="number" 
              value={def.maxOutputBytes ?? ""} 
              onChange={(e) => setDef({ ...def, maxOutputBytes: e.target.value === "" ? undefined : Number(e.target.value) })} 
              className="w-full mt-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus:border-[var(--accent)] outline-none transition" 
              placeholder="100000" 
            />
          </label>
          <label className="text-xs">
            <span className="text-[var(--text-secondary)] font-bold uppercase tracking-wider">Danger</span>
            <select 
              value={def.danger ?? "safe"} 
              onChange={(e) => setDef({ ...def, danger: e.target.value as any })} 
              className="w-full mt-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus:border-[var(--accent)] outline-none transition cursor-pointer"
            >
              <option>safe</option>
              <option>moderate</option>
              <option>high</option>
            </select>
          </label>
        </section>

        <section className="bg-[var(--bg-secondary)]/50 border border-[var(--border)] rounded-xl p-4">
          <div className="flex gap-6 text-xs mb-3">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input type="checkbox" checked={!!def.confirm} onChange={(e) => setDef({ ...def, confirm: e.target.checked })} className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]" /> 
              <span className="group-hover:text-[var(--text-primary)] transition">Confirm</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <input type="checkbox" checked={!!def.disabled} onChange={(e) => setDef({ ...def, disabled: e.target.checked })} className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]" /> 
              <span className="group-hover:text-[var(--text-primary)] transition">Disabled</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <input type="checkbox" checked={!!def.argSeparator} onChange={(e) => setDef({ ...def, argSeparator: e.target.checked })} className="rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]" /> 
              <span className="group-hover:text-[var(--text-primary)] transition">ArgSeparator</span>
            </label>
          </div>
          <ul className="text-[10px] text-[var(--text-secondary)] space-y-1 opacity-80">
            <li>• <b>confirm</b> — Pause for human approval before execution.</li>
            <li>• <b>disabled</b> — Validated but hidden from the agent.</li>
            <li>• <b>argSeparator</b> — Insert <code>--</code> before the first substituted element.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-secondary)] text-xs font-bold uppercase tracking-wider">Parameters</span>
            <button 
              onClick={() => setParams((p) => ({ ...p, [`param${Object.keys(p).length + 1}`]: { type: "string" } }))} 
              className="text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--accent)] hover:text-black transition-all"
            >
              + Add Parameter
            </button>
          </div>
          
          <div className="space-y-3">
            {Object.entries(def.params ?? {}).map(([pname, pdef]) => (
              <ParamEditor key={pname} name={pname} def={pdef}
                onChange={(n, d) => setParams((p) => ({ ...p, [n]: d }))}
                onRename={(oldN, newN) => setParams((p) => { const { [oldN]: v, ...rest } = p; return { ...rest, [newN]: v }; })}
                onDelete={() => setParams((p) => { const { [pname]: _, ...rest } = p; return rest; })}
              />
            ))}
            {Object.keys(def.params ?? {}).length === 0 && (
              <div className="text-center py-8 border border-dashed border-[var(--border)] rounded-xl text-[var(--text-secondary)] text-xs italic">
                No parameters defined for this tool.
              </div>
            )}
          </div>
        </section>
      </div>

      <div className={`flex justify-end gap-3 pt-6 border-t border-[var(--border)] ${inline ? "sticky bottom-0 bg-[var(--bg-primary)] py-4 mt-8 z-10" : ""}`}>
        {onCancel && (
          <button 
            onClick={onCancel} 
            className="px-4 py-2 text-sm font-bold border border-[var(--border)] rounded-lg hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/50 transition-all"
          >
            Cancel
          </button>
        )}
        <button 
          disabled={!isValid} 
          onClick={() => onSave(name, def)} 
          className="px-6 py-2 text-sm font-bold bg-[var(--accent)] text-black rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-[0_0_15px_rgba(229,192,121,0.3)] transition-all"
        >
          {initial?.name ? "Update Tool" : "Create Tool"}
        </button>
      </div>
    </div>
  );
}
