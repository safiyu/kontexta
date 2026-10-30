"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, GitMerge, X, CheckCircle2, AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ConflictRecord, ConflictStrategy } from "kxta-core";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConflictList } from "@/components/conflicts/conflict-list";
import { ConflictDiff, type DiffViewMode } from "@/components/conflicts/conflict-diff";
import { ResolveActions, STRATEGY_META } from "@/components/conflicts/resolve-actions";
import { relTime } from "@/components/conflicts/conflict-utils";

type Filter = "unresolved" | "all";

export function ConflictsClient() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("unresolved");
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [unresolved, setUnresolved] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [mergedText, setMergedText] = useState("");
  const [busy, setBusy] = useState<ConflictStrategy | null>(null);
  const [pendingStrategy, setPendingStrategy] = useState<ConflictStrategy | null>(null);

  const fetchConflicts = useCallback(async (f: Filter) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/conflicts?status=${f}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load conflicts (${res.status})`);
      const data = (await res.json()) as { conflicts: ConflictRecord[]; unresolved: number };
      setConflicts(data.conflicts);
      setUnresolved(data.unresolved);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load conflicts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConflicts(filter);
  }, [fetchConflicts, filter]);

  // Auto-select the most recent conflict once the list is ready.
  useEffect(() => {
    if (!loading && !selectedGid && conflicts.length > 0) {
      setSelectedGid(conflicts[0].gid);
      setMergedText(conflicts[0].local_content);
    }
  }, [loading, selectedGid, conflicts]);

  const [detail, setDetail] = useState<ConflictRecord | null>(null);

  // The list omits diffs; load the full record (with diff) for the selected conflict.
  useEffect(() => {
    if (!selectedGid) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/conflicts/${encodeURIComponent(selectedGid)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ConflictRecord;
        if (!cancelled) setDetail(data);
      } catch {
        // list row stays usable without a diff
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedGid, conflicts]);

  const listed = selectedGid ? conflicts.find((c) => c.gid === selectedGid) ?? null : null;
  const selected: ConflictRecord | null =
    listed && detail && detail.gid === listed.gid && detail.id === listed.id ? detail : listed;

  const handleSelect = useCallback((c: ConflictRecord) => {
    setSelectedGid(c.gid);
    setMergedText(c.local_content);
  }, []);

  const handleFilter = useCallback(
    (f: Filter) => {
      setFilter(f);
      setSelectedGid(null);
      setMergedText("");
      // fetchConflicts is re-triggered by the [filter] effect above.
    },
    []
  );

  const resolve = useCallback(
    async (strategy: ConflictStrategy, mergedContent?: string) => {
      if (!selected) return;
      setBusy(strategy);
      try {
        const res = await fetch(`/api/conflicts/${encodeURIComponent(selected.gid)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mergedContent !== undefined ? { strategy, mergedContent } : { strategy }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; strategy?: ConflictStrategy };
        if (!res.ok) throw new Error(data.error ?? `Resolve failed (${res.status})`);
        toast.success(`Conflict resolved (${data.strategy ?? strategy})`);
        setSelectedGid(null);
        setMergedText("");
        await fetchConflicts(filter);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("kontexta:conflicts-changed"));
        }
      } catch (e: any) {
        toast.error(e?.message ?? "Failed to resolve conflict");
      } finally {
        setBusy(null);
      }
    },
    [selected, filter, fetchConflicts]
  );

  const requestResolve = useCallback(
    (strategy: ConflictStrategy, mergedContent?: string) => {
      if (!selected) return;
      // keep-server overwrites the local file: require explicit confirmation.
      if (strategy === "keep-server") {
        setPendingStrategy("keep-server");
        return;
      }
      if (strategy === "merged") {
        void resolve("merged", mergedContent ?? mergedText);
        return;
      }
      void resolve(strategy);
    },
    [selected, mergedText, resolve]
  );

  const confirmResolve = useCallback(async () => {
    if (!pendingStrategy) return;
    const s = pendingStrategy;
    setPendingStrategy(null);
    await resolve(s);
  }, [pendingStrategy, resolve]);

  const applyMerged = useCallback(() => {
    if (!selected) return;
    void resolve("merged", mergedText);
  }, [selected, mergedText, resolve]);

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-[var(--bg-secondary)] dark:bg-[var(--bg-primary)]">
      <header className="sticky top-0 z-30 h-16 bg-[var(--bg-secondary)]/80 backdrop-blur-xl border-b border-[var(--border)] flex items-center px-6 gap-2">
        <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => router.push("/")}>
          <span className="text-sm text-[var(--text-secondary)] hover:text-amber-accent transition-colors">Home</span>
          <ChevronRight className="w-4 h-4 text-[var(--muted)] opacity-40" aria-hidden />
          <span className="text-sm font-bold text-amber-accent">Conflict Manager</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
            {(["unresolved", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => handleFilter(f)}
                className={`px-3 h-8 text-xs font-medium capitalize transition-colors ${
                  filter === f
                    ? "bg-amber-accent/15 text-amber-accent"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="btn btn-icon-md btn-outline"
            aria-label="Close Conflict Manager and return to home"
            title="Close"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
      </header>

      <div className="flex-1 p-3 lg:p-4 flex gap-3 overflow-hidden">
        {/* Conflict list */}
        <aside className="w-80 shrink-0 floating-surface rounded-2xl shadow-2xl flex flex-col overflow-hidden relative">
          <div className="absolute inset-0 border border-amber-accent/10 rounded-2xl pointer-events-none z-20" />
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Conflicts</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-accent/15 text-amber-accent font-bold">
              {unresolved} open
            </span>
          </div>
          <ConflictList
            conflicts={conflicts}
            selectedGid={selectedGid}
            onSelect={handleSelect}
            loading={loading}
            unresolvedCount={unresolved}
            emptyTitle={filter === "unresolved" ? "No open conflicts" : "No conflicts"}
            emptyHint="Files changed on another machine are forked here for review before they overwrite anything."
          />
        </aside>

        {/* Detail */}
        <main className="flex-1 min-w-0 floating-surface rounded-2xl shadow-2xl relative flex flex-col overflow-hidden">
          <div className="absolute inset-0 border border-amber-accent/10 rounded-2xl pointer-events-none z-20" />
          {selected ? (
            <ConflictDetail
              conflict={selected}
              diffView={diffView}
              onDiffView={setDiffView}
              mergedText={mergedText}
              onMergedText={setMergedText}
              busy={busy}
              onResolve={requestResolve}
              onApplyMerged={applyMerged}
            />
          ) : (
            <EmptyState
              icon={<GitMerge className="w-6 h-6" />}
              title="Select a conflict"
              hint="Pick a file from the list to review the diff and resolve it."
            />
          )}
        </main>
      </div>

      <ConfirmDialog
        open={pendingStrategy === "keep-server"}
        onClose={() => setPendingStrategy(null)}
        onConfirm={confirmResolve}
        title="Keep the server version?"
        message={
          selected ? (
            <p>
              This overwrites{" "}
              <strong className="text-[var(--text-primary)]">{selected.file_path}</strong> with the version that
              arrived from{" "}
              <strong className="text-[var(--text-primary)]">{selected.origin_label ?? selected.origin}</strong> and
              deletes the conflict copy. Your local changes remain in the local git history.
            </p>
          ) : (
            "Keep the server version?"
          )
        }
        confirmLabel="Keep server"
        destructive
        loading={busy === "keep-server"}
      />
    </div>
  );
}

interface DetailProps {
  conflict: ConflictRecord;
  diffView: DiffViewMode;
  onDiffView: (v: DiffViewMode) => void;
  mergedText: string;
  onMergedText: (v: string) => void;
  busy: ConflictStrategy | null;
  onResolve: (s: ConflictStrategy, mergedContent?: string) => void;
  onApplyMerged: () => void;
}

function ConflictDetail({
  conflict: c,
  diffView,
  onDiffView,
  mergedText,
  onMergedText,
  busy,
  onResolve,
  onApplyMerged,
}: DetailProps) {
  const resolved = c.status === "resolved";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-bold text-[var(--text-primary)] truncate" title={c.file_path}>
            {c.file_path}
          </h2>
          {resolved ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 shrink-0">
              <CheckCircle2 className="w-3 h-3" aria-hidden /> Resolved
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-accent/15 text-amber-accent shrink-0">
              <AlertTriangle className="w-3 h-3" aria-hidden /> Unresolved
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
          <span>
            from <span className="text-[var(--text-primary)] font-medium">{c.origin_label ?? c.origin}</span>
          </span>
          {c.base_version !== null && <span>base v{c.base_version}</span>}
          {c.server_seq !== null && <span>server #{c.server_seq}</span>}
          <span>
            {c.additions ?? 0} added / {c.deletions ?? 0} removed
          </span>
          <span title={new Date(c.created_at).toLocaleString()}>{relTime(c.created_at)}</span>
        </div>
      </div>

      {/* Diff */}
      <ConflictDiff conflict={c} diffView={diffView} onDiffView={onDiffView} />

      {/* Resolution */}
      <ResolveActions
        conflict={c}
        busy={busy}
        onResolve={onResolve}
        mergedText={mergedText}
        onMergedText={onMergedText}
        onApplyMerged={onApplyMerged}
      />
    </div>
  );
}
