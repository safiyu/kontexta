"use client";
import { useState, useEffect } from "react";

interface Status {
  slug: string;
  high_water: { last_event_ts: string; events_processed: number; last_distilled_at?: string } | null;
  open_tasks_count: number;
  open_tasks: Array<{ task_slug: string; last_active_at: string; status_latest: string | null }>;
}

export function LiveStatus({ projectId }: { projectId: number }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const refresh = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/journal-status`, { signal: ac.signal });
        if (!res.ok) {
          if (!cancelled) setError(`status request failed: ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      } catch (e: unknown) {
        if (cancelled || (e as any).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => { 
      cancelled = true; 
      ac.abort();
      clearInterval(t); 
    };
  }, [projectId]);

  if (error) return <div className="text-sm text-red-500">Status error: {error}</div>;
  if (!status) return <div className="text-sm text-gray-400">Loading status…</div>;

  return (
    <section className="border rounded p-3 bg-gray-50 dark:bg-gray-900/40 text-sm">
      <h3 className="font-medium mb-2">Journal status</h3>
      <div className="space-y-1">
        <div>Project: <span className="font-mono">{status.slug}</span></div>
        <div>
          Last distilled event:{" "}
          <span className="font-mono">{status.high_water?.last_event_ts ?? "never"}</span>
        </div>
        <div>Events processed (cumulative): {status.high_water?.events_processed ?? 0}</div>
        <div>Open tasks: {status.open_tasks_count}</div>
        {status.open_tasks.length > 0 && (
          <ul className="ml-4 list-disc mt-2">
            {status.open_tasks.map((t) => (
              <li key={t.task_slug}>
                <span className="font-mono">{t.task_slug}</span> — {t.status_latest ?? "(no status)"} —{" "}
                <span className="text-gray-500">{t.last_active_at}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
