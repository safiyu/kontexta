"use client";

import { useEffect, useState } from "react";
import type { ConflictRecord, ConflictStrategy } from "kxta-core";
import {
  CheckCircle2,
  Server,
  HardDrive,
  Files,
  GitMerge,
  RotateCcw,
} from "lucide-react";
import { relTime } from "./conflict-utils";

export interface StrategyMetaItem {
  label: string;
  hint: string;
  description: string;
  loadingLabel: string;
}

export const STRATEGY_META: Record<ConflictStrategy, StrategyMetaItem> = {
  "keep-server": {
    label: "Keep server",
    hint: "Overwrite the local file with the remote version and delete the conflict copy.",
    description: "Accepts the remote version arriving from the server. Your local modifications will be replaced, but remain preserved in local git history.",
    loadingLabel: "Keeping server…",
  },
  "keep-mine": {
    label: "Keep mine",
    hint: "Re-assert the local file, push it to the server, and delete the conflict copy.",
    description: "Re-asserts the local copy as canonical, increments its version, pushes an update to the server, and deletes the conflict copy.",
    loadingLabel: "Keeping mine…",
  },
  "keep-both": {
    label: "Keep both",
    hint: "Keep the local file and retain the conflict copy as a separate file.",
    description: "Retains the canonical local file and permanently keeps the conflict copy under a distinct origin-labeled filename.",
    loadingLabel: "Keeping both…",
  },
  merged: {
    label: "Use merged",
    hint: "Apply the edited merged text below, push it to the server, and delete the conflict copy.",
    description: "Applies the manually edited merged text to the canonical file, pushes the update to the server, and deletes the conflict copy.",
    loadingLabel: "Applying…",
  },
};

const STRATEGY_ORDER: ConflictStrategy[] = [
  "keep-server",
  "keep-mine",
  "keep-both",
  "merged",
];

export interface ResolveActionsProps {
  conflict: ConflictRecord;
  busy?: ConflictStrategy | null;
  onResolve: (strategy: ConflictStrategy, mergedContent?: string) => void;
  mergedText?: string;
  onMergedText?: (text: string) => void;
  onApplyMerged?: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Action toolbar for conflict resolution strategies:
 * `keep-server`, `keep-mine`, `keep-both`, and `merged` (with merged content editor).
 */
export function ResolveActions({
  conflict,
  busy = null,
  onResolve,
  mergedText,
  onMergedText,
  onApplyMerged,
  disabled = false,
  className = "",
}: ResolveActionsProps) {
  const resolved = conflict.status === "resolved";
  const [hoveredStrategy, setHoveredStrategy] = useState<ConflictStrategy | null>(null);

  // Support both controlled and uncontrolled merged content state.
  const [internalMergedText, setInternalMergedText] = useState(conflict.local_content ?? "");

  useEffect(() => {
    if (mergedText === undefined) {
      setInternalMergedText(conflict.local_content ?? "");
    }
  }, [conflict.gid, conflict.local_content, mergedText]);

  const currentMergedText = mergedText !== undefined ? mergedText : internalMergedText;

  const handleMergedChange = (val: string) => {
    if (onMergedText) {
      onMergedText(val);
    } else {
      setInternalMergedText(val);
    }
  };

  const handleApplyMerged = () => {
    if (onApplyMerged) {
      onApplyMerged();
    } else {
      onResolve("merged", currentMergedText);
    }
  };

  const handleStrategyClick = (s: ConflictStrategy) => {
    if (s === "merged") {
      handleApplyMerged();
    } else {
      onResolve(s);
    }
  };

  const isBusy = busy !== null || disabled;

  const renderIcon = (strategy: ConflictStrategy) => {
    switch (strategy) {
      case "keep-server":
        return <Server className="w-3.5 h-3.5" aria-hidden />;
      case "keep-mine":
        return <HardDrive className="w-3.5 h-3.5" aria-hidden />;
      case "keep-both":
        return <Files className="w-3.5 h-3.5" aria-hidden />;
      case "merged":
        return <GitMerge className="w-3.5 h-3.5" aria-hidden />;
    }
  };

  return (
    <div
      className={`border-t border-[var(--border)] px-5 py-4 ${className}`}
      data-testid="resolve-actions"
    >
      {resolved ? (
        <div
          className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]"
          data-testid="resolved-status"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" aria-hidden />
          <span className="font-medium text-[var(--text-primary)]">Resolved</span>
          {conflict.resolution ? (
            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[11px] font-medium text-[var(--text-primary)] font-mono">
              {conflict.resolution}
            </span>
          ) : null}
          {conflict.resolved_at ? (
            <span className="text-[11px] text-[var(--muted)]">
              {relTime(conflict.resolved_at)}
            </span>
          ) : null}
        </div>
      ) : (
        <>
          {/* Strategy action buttons */}
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Conflict resolution actions">
            {STRATEGY_ORDER.map((s) => {
              const meta = STRATEGY_META[s];
              const isThisBusy = busy === s;
              const isDestructive = s === "keep-server";
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleStrategyClick(s)}
                  onMouseEnter={() => setHoveredStrategy(s)}
                  onMouseLeave={() => setHoveredStrategy(null)}
                  disabled={isBusy}
                  className={`btn btn-sm inline-flex items-center gap-1.5 ${
                    isDestructive ? "btn-destructive" : "btn-outline"
                  }`}
                  title={meta.hint}
                  aria-label={meta.label}
                  data-testid={`strategy-${s}`}
                >
                  {renderIcon(s)}
                  <span>{isThisBusy ? meta.loadingLabel : meta.label}</span>
                </button>
              );
            })}
          </div>

          {/* Strategy hint */}
          <p
            className="mt-2 text-[11px] text-[var(--text-secondary)]"
            data-testid="strategy-hint"
          >
            {STRATEGY_META[busy ?? hoveredStrategy ?? "keep-server"].hint}
          </p>

          {/* Merged content editor */}
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="merged-editor"
                className="block text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]"
              >
                Merged content <span className="font-normal normal-case">— edit, then apply</span>
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleMergedChange(conflict.local_content ?? "")}
                  disabled={isBusy}
                  className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline transition-colors inline-flex items-center gap-1"
                  title="Reset editor text to the local version"
                >
                  <RotateCcw className="w-2.5 h-2.5" aria-hidden />
                  Use local
                </button>
                <span className="text-[var(--muted)] text-[10px]">•</span>
                <button
                  type="button"
                  onClick={() => handleMergedChange(conflict.remote_content ?? "")}
                  disabled={isBusy}
                  className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline transition-colors inline-flex items-center gap-1"
                  title="Reset editor text to the remote version"
                >
                  <RotateCcw className="w-2.5 h-2.5" aria-hidden />
                  Use remote
                </button>
              </div>
            </div>

            <textarea
              id="merged-editor"
              value={currentMergedText}
              onChange={(e) => handleMergedChange(e.target.value)}
              rows={6}
              spellCheck={false}
              disabled={isBusy}
              aria-label="Merged content"
              placeholder="Edit merged content..."
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)]/40 text-[12px] font-mono p-3 outline-none focus:border-amber-accent/60 resize-y"
            />

            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={handleApplyMerged}
                disabled={isBusy}
                className="btn btn-sm btn-primary inline-flex items-center gap-1.5"
                data-testid="apply-merged-button"
              >
                <GitMerge className="w-3.5 h-3.5" aria-hidden />
                <span>{busy === "merged" ? "Applying…" : "Apply merged & resolve"}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
