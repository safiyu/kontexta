"use client";

import { useEffect, useState, useMemo } from "react";
import { ToolCard, type ToolEntry } from "@/components/docs/tool-card";

interface ApiResp {
  categoryOrder: string[];
  tools: ToolEntry[];
}

export function ToolsSection() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/api/mcp-tools").then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.tools.filter(
      (t) => !needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)
    );
  }, [data, q]);

  const grouped = useMemo(() => {
    if (!data) return new Map<string, ToolEntry[]>();
    const m = new Map<string, ToolEntry[]>();
    for (const c of data.categoryOrder) m.set(c, []);
    for (const t of filtered) {
      const arr = m.get(t.category) ?? [];
      arr.push(t);
      m.set(t.category, arr);
    }
    return m;
  }, [data, filtered]);

  if (!data) return <div className="text-sm">Loading…</div>;

  return (
    <div className="max-w-4xl mx-auto">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search tools…"
        className="w-full px-3 py-2 mb-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded sticky top-0 z-10"
      />
      {[...grouped.entries()].map(([cat, tools]) => tools.length === 0 ? null : (
        <section key={cat} className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-[var(--text-secondary)] mb-2">{cat}</h2>
          {tools.map((t) => <ToolCard key={t.name} tool={t} />)}
        </section>
      ))}
    </div>
  );
}
