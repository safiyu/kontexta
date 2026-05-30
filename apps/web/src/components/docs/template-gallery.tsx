"use client";

import type { ToolDef } from "./tool-form";
import { HAND_TOOL_TEMPLATES } from "@/lib/hand-tool-templates";

interface Props {
  onSelectTemplate: (name: string, def: ToolDef) => void;
  onBlank: () => void;
  heading?: string;
}

function badgesFor(def: ToolDef): string[] {
  const b: string[] = [];
  b.push(def.danger ?? "safe");
  const paramCount = Object.keys(def.params ?? {}).length;
  if (paramCount > 0) b.push(`${paramCount}p`);
  if (def.confirm) b.push("confirm");
  if (def.argSeparator) b.push("argSep");
  if (def.disabled) b.push("disabled");
  return b;
}

export function TemplateGallery({ onSelectTemplate, onBlank, heading }: Props) {
  return (
    <div className="flex flex-col gap-6 py-2">
      {heading && (
        <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-secondary)]">
          {heading}
        </p>
      )}

      <button
        onClick={onBlank}
        className="w-full px-4 py-3 text-xs font-bold uppercase tracking-widest border border-dashed border-[var(--border)] rounded-xl text-[var(--text-secondary)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] hover:border-[var(--accent)] transition-all flex items-center justify-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        Start from scratch
      </button>
      
      <div className="flex flex-col gap-3">
        {HAND_TOOL_TEMPLATES.map((t) => (
          <button
            key={t.name}
            onClick={() => onSelectTemplate(t.name, t.def)}
            className="text-left p-4 border border-[var(--border)] rounded-xl bg-[var(--bg-secondary)]/50 hover:bg-[var(--accent)] hover:text-black hover:border-transparent transition-all group shadow-sm hover:shadow-lg active:scale-[0.98]"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="font-mono font-bold text-[13px] tracking-tight">{t.name}</div>
              <div className="flex gap-1">
                {badgesFor(t.def).slice(0, 2).map((b) => (
                  <span
                    key={b}
                    className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md bg-[var(--bg-primary)] group-hover:bg-black/10 text-[var(--text-secondary)] group-hover:text-black border border-[var(--border)] group-hover:border-transparent"
                  >
                    {b}
                  </span>
                ))}
              </div>
            </div>
            <p className="text-xs text-[var(--text-secondary)] group-hover:text-black/80 leading-relaxed line-clamp-2">
              {t.oneLiner}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
