"use client";

import { useState } from "react";
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

const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface Props {
  open: boolean;
  initial: { name: string; def: ToolDef } | null;
  projectName?: string;
  onSave: (name: string, def: ToolDef) => void;
  onClose: () => void;
}

export function ToolFormModal({ open, initial, projectName, onSave, onClose }: Props) {
  // Initialize from `initial` once at mount. Parent controls remount via
  // `{modalOpen && <ToolFormModal ... />}`, so a fresh open ⇒ fresh hook state.
  const [name, setName] = useState(initial?.name ?? "");
  const [def, setDef] = useState<ToolDef>(initial?.def ?? { description: "", command: [] });

  if (!open) return null;

  const declaredParams = Object.keys(def.params ?? {});
  const isValid =
    NAME_RE.test(name) &&
    def.description.trim().length > 0 &&
    def.command.length > 0 &&
    !def.command[0].includes("{{");

  const setParams = (mut: (p: Record<string, ParamDef>) => Record<string, ParamDef>) =>
    setDef({ ...def, params: mut({ ...(def.params ?? {}) }) });

  return (
    <div role="dialog" className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-12" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[640px] max-h-[80vh] overflow-auto bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-semibold">{initial ? "Edit tool" : "Add tool"}</h2>

        <label className="block text-xs">
          <span className="text-[var(--text-secondary)]">Tool name</span>
          <input
            aria-label="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. run-tests"
            className="w-full px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded font-mono"
          />
          <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">
            Lowercase letters, digits, hyphens. Kontexta namespaces it automatically — the agent sees{" "}
            <code className="text-[var(--accent)]">
              {(projectName ?? "&lt;project&gt;")}__{name || "&lt;name&gt;"}
            </code>
            .
          </span>
          {name && !NAME_RE.test(name) && <span className="text-red-500">must match ^[a-z][a-z0-9-]*$</span>}
        </label>

        <label className="block text-xs">
          <span className="text-[var(--text-secondary)]">Description</span>
          <input aria-label="description" value={def.description} onChange={(e) => setDef({ ...def, description: e.target.value })} className="w-full px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded" />
          <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">
            What the agent sees when deciding whether to call this tool. Be specific about what it does and when to use it.
          </span>
        </label>

        <div className="text-xs">
          <span className="text-[var(--text-secondary)]">Command argv</span>
          <ArgvChipEditor value={def.command} onChange={(v) => setDef({ ...def, command: v })} declaredParams={declaredParams} />
          <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">
            argv passed to <code>spawn</code> (no shell). argv[0] is the executable — must be a literal, no <code>{"{{"}</code>placeholders<code>{"}}"}</code>. Subsequent items can use <code>{"{{paramName}}"}</code>.
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <label>
            Timeout (ms)
            <input type="number" value={def.timeout ?? ""} onChange={(e) => setDef({ ...def, timeout: e.target.value === "" ? undefined : Number(e.target.value) })} className="w-full px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded" placeholder="60000" />
            <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">Default 60000, max 300000. Process group is SIGTERM'd then SIGKILL'd 3s later.</span>
          </label>
          <label>
            Max output
            <input type="number" value={def.maxOutputBytes ?? ""} onChange={(e) => setDef({ ...def, maxOutputBytes: e.target.value === "" ? undefined : Number(e.target.value) })} className="w-full px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded" placeholder="100000" />
            <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">Per-stream byte cap. Default 100000, max 1000000. Output is truncated in the middle.</span>
          </label>
          <label>
            Danger
            <select value={def.danger ?? "safe"} onChange={(e) => setDef({ ...def, danger: e.target.value as any })} className="w-full px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded"><option>safe</option><option>moderate</option><option>high</option></select>
            <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">Informational label. Use <code>confirm</code> to actually pause execution.</span>
          </label>
        </div>

        <div className="space-y-1 text-xs">
          <div className="flex gap-3">
            <label><input type="checkbox" checked={!!def.confirm} onChange={(e) => setDef({ ...def, confirm: e.target.checked })} /> confirm</label>
            <label><input type="checkbox" checked={!!def.disabled} onChange={(e) => setDef({ ...def, disabled: e.target.checked })} /> disabled</label>
            <label><input type="checkbox" checked={!!def.argSeparator} onChange={(e) => setDef({ ...def, argSeparator: e.target.checked })} /> argSeparator</label>
          </div>
          <ul className="text-[10px] text-[var(--text-secondary)] pl-1 space-y-0.5">
            <li><b>confirm</b> — pause for human approval. The first call returns a token; the agent must call <code>confirm_hand({"{ token }"})</code> within 60s to execute.</li>
            <li><b>disabled</b> — validated but never registered. The agent never sees it. Use to keep high-risk tools in the file but invisible.</li>
            <li><b>argSeparator</b> — insert <code>--</code> in argv before the first substituted element. Defense against argv injection on path-accepting commands.</li>
          </ul>
        </div>

        <div className="text-xs">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[var(--text-secondary)]">Parameters</span>
            <button onClick={() => setParams((p) => ({ ...p, [`param${Object.keys(p).length + 1}`]: { type: "string" } }))} className="text-xs px-2 py-0.5 border border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black">+ Add</button>
          </div>
          <span className="block text-[10px] text-[var(--text-secondary)] mb-1">
            Inputs the agent supplies. Reference each in <code>command</code> via <code>{"{{name}}"}</code>. Strings without an explicit pattern get the default <code>^[^-].*</code> (blocks argv injection).
          </span>
          {Object.entries(def.params ?? {}).map(([pname, pdef]) => (
            <ParamEditor key={pname} name={pname} def={pdef}
              onChange={(n, d) => setParams((p) => ({ ...p, [n]: d }))}
              onRename={(oldN, newN) => setParams((p) => { const { [oldN]: v, ...rest } = p; return { ...rest, [newN]: v }; })}
              onDelete={() => setParams((p) => { const { [pname]: _, ...rest } = p; return rest; })}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-[var(--border)]">
          <button onClick={onClose} className="px-3 py-1 text-sm border border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black">Cancel</button>
          <button disabled={!isValid} onClick={() => onSave(name, def)} className="px-3 py-1 text-sm bg-[var(--accent)] text-black rounded disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
        </div>
      </div>
    </div>
  );
}
