"use client";

import type { ToolDef } from "./tool-form-modal";
import { HAND_TOOL_TEMPLATES } from "@/lib/hand-tool-templates";

interface Props {
  onSelectTemplate: (name: string, def: ToolDef) => void;
  onBlank: () => void;
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

export function TemplateGallery({ onSelectTemplate, onBlank }: Props) {
  return (
    <div className="text-center py-6">
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        No hand tools yet. Start with a template:
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl mx-auto">
        {HAND_TOOL_TEMPLATES.map((t) => (
          <button
            key={t.name}
            onClick={() => onSelectTemplate(t.name, t.def)}
            className="text-left p-3 border border-[var(--border)] rounded bg-[var(--bg-secondary)] hover:bg-[var(--accent)] hover:text-black transition group"
          >
            <div className="font-mono font-semibold text-sm mb-1">{t.name}</div>
            <p className="text-xs text-[var(--text-secondary)] group-hover:text-black mb-2 leading-snug">
              {t.oneLiner}
            </p>
            <div className="flex flex-wrap gap-1">
              {badgesFor(t.def).map((b) => (
                <span
                  key={b}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] group-hover:bg-black/10 text-[var(--text-secondary)] group-hover:text-black"
                >
                  {b}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
      <div className="mt-6">
        <button
          onClick={onBlank}
          className="px-4 py-2 text-sm border border-dashed border-[var(--border)] rounded hover:bg-[var(--accent)] hover:text-black transition"
        >
          + Start from scratch
        </button>
      </div>
    </div>
  );
}
