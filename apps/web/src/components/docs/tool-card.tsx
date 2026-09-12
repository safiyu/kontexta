"use client";

import { useState, useEffect } from "react";
import { JsonSchemaTable } from "./json-schema-table";

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: any;
  category: string;
}

// First sentence for the collapsed preview; fall back to a hard char cap if no sentence break.
function previewLine(text: string): string {
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (m) return m[0];
  return text.length > 140 ? text.slice(0, 140).trimEnd() + "…" : text;
}

export function ToolCard({ tool }: { tool: ToolEntry }) {
  const [open, setOpen] = useState(false);

  // Auto-open when the user lands via #tool-name deep link.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === `#${tool.name}`) {
      setOpen(true);
    }
  }, [tool.name]);

  return (
    <div id={tool.name} className="border border-[var(--border)] rounded-md mb-2 bg-[var(--bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-[var(--bg-tertiary)]/40 transition-colors rounded-md"
        aria-expanded={open}
      >
        <span className="text-[10px] text-[var(--text-secondary)] mt-1 w-3 shrink-0 select-none">
          {open ? "▾" : "▸"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-mono text-sm font-semibold">{tool.name}</h3>
            <a
              href={`#${tool.name}`}
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-[var(--text-secondary)] shrink-0"
              title="permalink"
            >
              §
            </a>
          </div>
          {!open && (
            <p className="text-xs text-[var(--text-secondary)] mt-0.5 line-clamp-1">
              {previewLine(tool.description)}
            </p>
          )}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9">
          <p className="text-sm whitespace-pre-wrap mb-3">{tool.description}</p>
          <JsonSchemaTable schema={tool.inputSchema} />
        </div>
      )}
    </div>
  );
}
