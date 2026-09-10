"use client";

import { useEffect, useState } from "react";
import { Link2, FileText, ChevronDown } from "lucide-react";

interface Backlink {
  id: number;
  title: string;
  path: string;
  snippet: string | null;
  reason: "title" | "basename" | "wikilink";
}

interface BacklinksPanelProps {
  fileId: number;
  onSelectFile: (id: number) => void;
}

// FTS snippet markers — swap for a highlighted span so matches stand out inline.
function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/<<<|>>>/);
  return parts.map((chunk, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-[var(--accent-soft)] text-[var(--accent)] px-0.5 rounded-sm">
        {chunk}
      </mark>
    ) : (
      <span key={i}>{chunk}</span>
    )
  );
}

function reasonLabel(r: Backlink["reason"]): string {
  if (r === "title") return "title mention";
  if (r === "basename") return "path mention";
  return "wikilink";
}

export function BacklinksPanel({ fileId, onSelectFile }: BacklinksPanelProps) {
  const [links, setLinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/files/${fileId}/backlinks`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setLinks((body.backlinks ?? []) as Backlink[]);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load backlinks");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fileId]);

  if (loading) {
    return (
      <div className="border-t border-[var(--border)] px-6 py-4">
        <div className="skeleton h-4 w-32" />
      </div>
    );
  }

  // Nothing to link means we hide the panel entirely — no visual weight for empty state.
  if (error || links.length === 0) return null;

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-6 py-3 text-left hover:bg-[var(--bg-secondary)]/60 transition-colors"
        aria-expanded={expanded}
      >
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform text-[var(--text-secondary)] ${expanded ? "" : "-rotate-90"}`} aria-hidden />
        <Link2 className="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-primary)]">
          Referenced by
        </span>
        <span className="text-[11px] text-[var(--text-secondary)] font-mono">{links.length}</span>
      </button>
      {expanded && (
        <ul className="divide-y divide-[var(--border)]">
          {links.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => onSelectFile(l.id)}
                className="w-full text-left px-6 py-3 hover:bg-[var(--bg-secondary)] transition-colors group"
              >
                <div className="flex items-start gap-3">
                  <FileText className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--text-secondary)] group-hover:text-[var(--accent)]" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">{l.title}</span>
                      <span className="text-[10px] uppercase tracking-widest text-[var(--text-secondary)]/70 font-semibold shrink-0">
                        {reasonLabel(l.reason)}
                      </span>
                    </div>
                    {l.snippet && (
                      <p className="mt-1 text-[12px] text-[var(--text-secondary)] leading-relaxed line-clamp-2">
                        {renderSnippet(l.snippet)}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
