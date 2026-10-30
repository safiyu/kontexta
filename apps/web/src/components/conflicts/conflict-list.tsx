"use client";

import type { ConflictRecord } from "kxta-core";
import { CheckCircle2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { relTime } from "./conflict-utils";

export interface ConflictListProps {
  conflicts: ConflictRecord[];
  selectedGid: string | null;
  onSelect: (c: ConflictRecord) => void;
  loading: boolean;
  /** Count shown in the header badge (unresolved total). */
  unresolvedCount: number;
  emptyTitle: string;
  emptyHint?: string;
}

/** Sidebar listing conflicting files and metadata. */
export function ConflictList({
  conflicts,
  selectedGid,
  onSelect,
  loading,
  unresolvedCount,
  emptyTitle,
  emptyHint,
}: ConflictListProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      {loading ? (
        <EmptyState title="Loading conflicts…" />
      ) : conflicts.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="w-6 h-6" aria-hidden />}
          title={emptyTitle}
          hint={emptyHint}
        />
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {conflicts.map((c) => {
            const active = c.gid === selectedGid;
            return (
              <li key={c.gid}>
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    active ? "bg-amber-accent/10" : "hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 w-2 h-2 rounded-full ${
                        c.status === "unresolved" ? "bg-amber-accent" : "bg-emerald-500"
                      }`}
                    />
                    <span className="flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {c.file_path}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-4 text-[11px] text-[var(--text-secondary)]">
                    <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] truncate max-w-[110px]">
                      {c.origin_label ?? c.origin}
                    </span>
                    {c.additions !== undefined && (
                      <span>
                        {c.additions}+/{c.deletions ?? 0}-
                      </span>
                    )}
                    <span className="ml-auto shrink-0">{relTime(c.created_at)}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
