"use client";
import { useState } from "react";

const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

interface Props {
  value: string[];
  onChange: (v: string[]) => void;
  declaredParams: string[];
}

export function ArgvChipEditor({ value, onChange, declaredParams }: Props) {
  const [draft, setDraft] = useState("");
  const declared = new Set(declaredParams);

  const placeholdersOk = (s: string): boolean => {
    PLACEHOLDER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_RE.exec(s))) {
      if (!declared.has(m[1])) return false;
    }
    return true;
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((arg, i) => {
        const ok = placeholdersOk(arg);
        return (
          <span key={i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono border ${ok ? "border-[var(--border)] bg-[var(--bg-secondary)]" : "border-red-500 text-red-400"}`}>
            {arg}
            <button aria-label={`remove ${arg}`} onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-[var(--text-secondary)] hover:text-red-500">×</button>
          </span>
        );
      })}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Commit on Enter, Tab, Space, or comma — match common chip-editor habits.
          const commit =
            (e.key === "Enter" || e.key === "Tab" || e.key === "," ||
              (e.key === " " && draft.trim().length > 0)) &&
            draft.trim().length > 0;
          if (commit) {
            e.preventDefault();
            onChange([...value, draft.trim()]);
            setDraft("");
          }
        }}
        onBlur={() => {
          // Commit any pending text when the input loses focus.
          if (draft.trim().length > 0) {
            onChange([...value, draft.trim()]);
            setDraft("");
          }
        }}
        placeholder="+ arg (Enter)"
        className="px-2 py-0.5 text-xs bg-transparent border border-dashed border-[var(--border)] rounded font-mono w-32"
      />
    </div>
  );
}
