"use client";

import { PatternTester } from "./pattern-tester";

export interface ParamDef {
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  pattern?: string;
  min?: number;
  max?: number;
}

interface Props {
  name: string;
  def: ParamDef;
  onChange: (name: string, def: ParamDef) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: () => void;
}

export function ParamEditor({ name, def, onChange, onRename, onDelete }: Props) {
  return (
    <div className="border border-[var(--border)] rounded p-2 mb-2 text-xs space-y-1">
      <div className="flex gap-2 items-center">
        <input value={name} onChange={(e) => onRename(name, e.target.value)} className="px-2 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded font-mono" title="Param name. Reference in command argv as {{name}}." />
        <select value={def.type} onChange={(e) => onChange(name, { ...def, type: e.target.value as any })} className="px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded" title="JSON type the agent must supply.">
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
        </select>
        <label className="flex items-center gap-1" title="If unchecked, default is used (or empty/0/false).">
          <input type="checkbox" checked={!!def.required} onChange={(e) => onChange(name, { ...def, required: e.target.checked })} /> required
        </label>
        <button onClick={onDelete} className="ml-auto text-[var(--text-secondary)] hover:text-red-500" aria-label={`delete param ${name}`}>×</button>
      </div>
      {def.type === "string" && (
        <div>
          <input
            value={def.pattern ?? ""}
            onChange={(e) => onChange(name, { ...def, pattern: e.target.value || undefined })}
            placeholder="^[a-zA-Z0-9_-]+$"
            className="w-full px-2 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded font-mono"
          />
          <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">
            re2 regex (linear-time, ReDoS-proof). Empty values always pass. Without an explicit pattern, strings get the default <code>^[^-].*</code> which blocks values starting with a dash (argv-injection guard).
          </span>
          {def.pattern && <PatternTester pattern={def.pattern} />}
        </div>
      )}
      {def.type === "number" && (
        <div>
          <div className="flex gap-2">
            <input type="number" placeholder="min" value={def.min ?? ""} onChange={(e) => onChange(name, { ...def, min: e.target.value === "" ? undefined : Number(e.target.value) })} className="px-2 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded w-24" />
            <input type="number" placeholder="max" value={def.max ?? ""} onChange={(e) => onChange(name, { ...def, max: e.target.value === "" ? undefined : Number(e.target.value) })} className="px-2 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded w-24" />
          </div>
          <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">
            Inclusive bounds. NaN, Infinity, and values outside JS safe-integer range are rejected automatically.
          </span>
        </div>
      )}
      {def.type === "boolean" && (
        <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">
          Strict <code>true</code> / <code>false</code> only. No truthy coercion.
        </span>
      )}
    </div>
  );
}
