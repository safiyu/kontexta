"use client";

import { JsonSchemaTable } from "./json-schema-table";

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: any;
  category: string;
}

export function ToolCard({ tool }: { tool: ToolEntry }) {
  return (
    <div id={tool.name} className="border border-[var(--border)] rounded-md p-4 mb-3 bg-[var(--bg-secondary)]">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="font-mono text-base font-semibold">{tool.name}</h3>
        <a href={`#${tool.name}`} className="text-xs text-[var(--text-secondary)]" title="permalink">§</a>
      </div>
      <p className="text-sm whitespace-pre-wrap mb-3">{tool.description}</p>
      <JsonSchemaTable schema={tool.inputSchema} />
    </div>
  );
}
