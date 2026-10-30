"use client";

import type { ConflictRecord } from "kxta-core";
import { EmptyState } from "@/components/ui/empty-state";

export type DiffViewMode = "unified" | "split";

export interface DiffLine {
  type: "add" | "del" | "ctx" | "hunk" | "header" | "blank";
  text: string;
}

/** Split a unified diff string into styled, per-line records. */
export function parseDiff(diff: string | undefined): DiffLine[] {
  if (!diff) return [];
  return diff.split("\n").map((l) => {
    if (l.startsWith("+") && !l.startsWith("++")) return { type: "add", text: l.slice(1) };
    if (l.startsWith("-") && !l.startsWith("--")) return { type: "del", text: l.slice(1) };
    if (l.startsWith("+++") || l.startsWith("---")) return { type: "header", text: l };
    if (l.startsWith("@@")) return { type: "hunk", text: l };
    if (l.length === 0) return { type: "blank", text: "" };
    return { type: "ctx", text: l.startsWith(" ") ? l.slice(1) : l };
  });
}

export interface ConflictDiffProps {
  conflict: ConflictRecord;
  diffView: DiffViewMode;
  onDiffView: (v: DiffViewMode) => void;
}

/** Diff controls (unified / side-by-side) + the diff body. */
export function ConflictDiff({ conflict, diffView, onDiffView }: ConflictDiffProps) {
  const lines = parseDiff(conflict.diff);

  return (
    <>
      {/* Diff controls */}
      <div className="px-5 py-2.5 border-b border-[var(--border)] flex items-center gap-3">
        <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] font-bold">
          Local (this machine)
        </span>
        <span className="text-[var(--muted)]" aria-hidden>
          →
        </span>
        <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] font-bold">
          Remote ({conflict.origin_label ?? conflict.origin})
        </span>
        <div className="ml-auto flex rounded-md border border-[var(--border)] overflow-hidden">
          {(["unified", "split"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onDiffView(v)}
              className={`px-3 h-7 text-[11px] font-medium transition-colors ${
                diffView === v ? "bg-amber-accent/15 text-amber-accent" : "text-[var(--text-secondary)]"
              }`}
            >
              {v === "unified" ? "Unified" : "Side by side"}
            </button>
          ))}
        </div>
      </div>

      {/* Diff body */}
      <div className="flex-1 overflow-y-auto bg-[var(--bg-primary)]">
        {diffView === "unified" ? (
          <DiffUnified lines={lines} />
        ) : (
          <DiffSplit
            local={conflict.local_content}
            remote={conflict.remote_content}
            originLabel={conflict.origin_label ?? conflict.origin}
          />
        )}
      </div>
    </>
  );
}

function DiffUnified({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) {
    return <EmptyState title="No differences" hint="The two versions are identical." />;
  }
  return (
    <pre className="font-mono text-[12px] leading-relaxed px-4 py-3 overflow-x-auto">
      {lines.map((l, i) => {
        const cls =
          l.type === "add"
            ? "text-emerald-500 bg-emerald-500/10"
            : l.type === "del"
              ? "text-red-500 bg-red-500/10"
              : l.type === "hunk"
                ? "text-sky-500"
                : l.type === "header"
                  ? "text-[var(--muted)]"
                  : "text-[var(--text-secondary)]";
        const prefix = l.type === "add" ? "+ " : l.type === "del" ? "- " : "  ";
        return (
          <div key={i} className={`${cls} whitespace-pre-wrap break-all`}>
            {l.type === "blank" ? " " : prefix + l.text}
          </div>
        );
      })}
    </pre>
  );
}

function DiffSplit({ local, remote, originLabel }: { local: string; remote: string; originLabel: string }) {
  return (
    <div className="grid grid-cols-2 h-full min-h-[200px]">
      <div className="border-r border-[var(--border)] flex flex-col overflow-hidden">
        <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-secondary)]/50">
          Local (this machine)
        </div>
        <pre className="flex-1 overflow-auto font-mono text-[12px] leading-relaxed px-3 py-2 whitespace-pre-wrap break-all">
          {local || <span className="text-[var(--muted)]">(empty)</span>}
        </pre>
      </div>
      <div className="flex flex-col overflow-hidden">
        <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-secondary)]/50">
          Remote ({originLabel})
        </div>
        <pre className="flex-1 overflow-auto font-mono text-[12px] leading-relaxed px-3 py-2 whitespace-pre-wrap break-all">
          {remote || <span className="text-[var(--muted)]">(empty)</span>}
        </pre>
      </div>
    </div>
  );
}
