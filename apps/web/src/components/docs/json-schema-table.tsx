"use client";

interface PropSchema {
  type?: string;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: PropSchema;
}

interface ObjectSchema {
  type?: "object";
  properties?: Record<string, PropSchema>;
  required?: string[];
}

function formatType(p: PropSchema): string {
  if (p.enum) return "enum";
  if (p.type === "array" && p.items?.type) return `${p.items.type}[]`;
  return p.type ?? "any";
}

function formatNotes(p: PropSchema): string {
  const parts: string[] = [];
  if (p.enum) parts.push(p.enum.map((v) => String(v)).join(" | "));
  if (p.default !== undefined) parts.push(`default: ${JSON.stringify(p.default)}`);
  if (p.minimum !== undefined) parts.push(`min: ${p.minimum}`);
  if (p.maximum !== undefined) parts.push(`max: ${p.maximum}`);
  if (p.description) parts.push(p.description);
  return parts.join(" — ");
}

export function JsonSchemaTable({ schema }: { schema: ObjectSchema }) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(props);
  if (entries.length === 0) {
    return <div className="text-sm text-[var(--text-secondary)] italic">No parameters.</div>;
  }
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-[var(--border)] text-left text-xs uppercase text-[var(--text-secondary)]">
          <th className="py-1 pr-3">Param</th>
          <th className="py-1 pr-3">Type</th>
          <th className="py-1 pr-3">Required</th>
          <th className="py-1">Notes</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([name, p]) => (
          <tr key={name} className="border-b border-[var(--border)]">
            <td className="py-1 pr-3 font-mono">{name}</td>
            <td className="py-1 pr-3">{formatType(p)}</td>
            <td className="py-1 pr-3">{required.has(name) ? "required" : "optional"}</td>
            <td className="py-1">{formatNotes(p)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
