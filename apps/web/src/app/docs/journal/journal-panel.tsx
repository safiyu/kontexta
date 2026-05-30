"use client";
import { useState, useEffect } from "react";
import { SaveBar } from "../../../components/docs/save-bar";
import { LiveStatus } from "./live-status";

interface JournalConfig {
  mode: "lenient" | "strict" | "mechanical-only";
  retention: {
    raw_days: number;
    mechanical_only_days: number;
    narrative_days: number;
    archive_cold_after_days: number;
    purge_archived_after_days: number;
  };
  ticket_pattern: string;
  redact: { extra_keys: string[]; max_arg_size_bytes: number };
  webui_scheduler: {
    enabled: boolean;
    mechanical_distill_interval_minutes: number;
    housekeep_interval_hours: number;
  };
}

const DEFAULTS: JournalConfig = {
  mode: "lenient",
  retention: {
    raw_days: 90,
    mechanical_only_days: 365,
    narrative_days: 0,
    archive_cold_after_days: 365,
    purge_archived_after_days: 0,
  },
  ticket_pattern: "[A-Z]+-\\d+",
  redact: { extra_keys: [], max_arg_size_bytes: 1024 },
  webui_scheduler: {
    enabled: true,
    mechanical_distill_interval_minutes: 15,
    housekeep_interval_hours: 24,
  },
};

interface Project {
  id: number;
  name: string;
  path: string;
  slug: string;
}

const RETENTION_HINTS: Record<string, string> = {
  raw_days: "How long to keep raw JSONL events. Cost of high retention: Increased disk space usage. Low retention saves space but prevents deep auditing of past agent decisions.",
  mechanical_only_days: "How long to keep basic markdown summaries. Cost of high retention: Increased agent token usage and slower search times as the active index grows. Low retention keeps the index fast but risks losing older context.",
  narrative_days: "How long to keep rich LLM-generated summaries. Cost of high retention: Significant increase in agent token usage when searching or reading context. Low retention saves token budget but limits human-readable history.",
  archive_cold_after_days: "When to archive inactive topics. Cost of high retention: Agents will waste tokens reading stale context that clutters search results. Lower values keep the working context sharp.",
  purge_archived_after_days: "When to permanently delete archived items. Cost of high retention: Increased long-term disk storage. Low retention reclaims space but irreversibly destroys project history. (0 = never delete).",
};

export function JournalPanel() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [config, setConfig] = useState<JournalConfig>(DEFAULTS);
  const [unsaved, setUnsaved] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    fetch("/api/projects", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: Project[]) => {
        if (cancelled) return;
        setProjects(d);
        if (d.length > 0 && projectId === null) {
          setProjectId(d[0].id);
        }
      })
      .catch((e) => { 
        if (cancelled || e.name === "AbortError") return;
        setLoadError(e instanceof Error ? e.message : String(e)); 
      });
    return () => { 
      cancelled = true; 
      ac.abort();
    };
  }, []);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    const ac = new AbortController();
    fetch(`/api/projects/${projectId}/journal-config`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        if (d.journal) setConfig({ ...DEFAULTS, ...d.journal });
        setUnsaved(0);
      })
      .catch((e) => { 
        if (cancelled || e.name === "AbortError") return;
        setLoadError(e instanceof Error ? e.message : String(e)); 
      });
    return () => { 
      cancelled = true; 
      ac.abort();
    };
  }, [projectId]);

  function update<K extends keyof JournalConfig>(k: K, v: JournalConfig[K]) {
    setConfig({ ...config, [k]: v });
    setUnsaved((n) => n + 1);
  }

  async function save() {
    if (projectId === null) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/journal-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journal: config }),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      setUnsaved(0);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  function discard() {
    setConfig(DEFAULTS);
    setUnsaved(0);
  }

  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      {loadError && (
        <div className="border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 rounded p-2 text-sm">
          {loadError}
        </div>
      )}

      <section>
        <h2 className="text-lg font-medium mb-2">Project</h2>
        <select
          value={projectId ?? ""}
          onChange={(e) => setProjectId(Number(e.target.value))}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 min-w-[200px] text-xs"
        >
          <option value="">Select project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </section>

      {projectId !== null && (
        <>
          <LiveStatus projectId={projectId} />

          <section>
            <h2 className="text-lg font-medium mb-2">Mode</h2>
            <select
              value={config.mode}
              onChange={(e) => update("mode", e.target.value as JournalConfig["mode"])}
              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs"
            >
              <option value="lenient">Lenient (recommended)</option>
              <option value="strict">Strict — block reads when backlog exists</option>
              <option value="mechanical-only">Mechanical-only — no LLM upgrade</option>
            </select>
            <div className="mt-2 p-3 bg-amber-500/5 border border-amber-500/20 rounded text-xs text-[var(--text-secondary)] leading-normal">
              {config.mode === "lenient" && (
                <><strong>Lenient mode</strong> is unobtrusive. If undistilled events accumulate, the MCP server automatically runs a fast, background distillation to maintain memory without blocking the agent.</>
              )}
              {config.mode === "strict" && (
                <><strong>Strict mode</strong> enforces memory hygiene. It blocks read tools (like <code>search</code> or <code>read_file</code>) with a <code>JOURNAL_BACKLOG</code> error if undistilled events exist, forcing the agent to summarize its work first. Pass <code>journal_bypass: true</code> to override.</>
              )}
              {config.mode === "mechanical-only" && (
                <><strong>Mechanical-only mode</strong> functions like lenient mode but disables LLM processing. It prevents subagents from upgrading basic markdown logs into richer narratives, saving token costs on large projects.</>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">Retention (days; 0 = forever)</h2>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              {(["raw_days","mechanical_only_days","narrative_days","archive_cold_after_days","purge_archived_after_days"] as const).map((k) => (
                <label key={k} className="flex flex-col text-xs">
                  <span className="text-[var(--text-secondary)] flex items-center gap-1 mb-0.5">
                    {k}
                    <span title={RETENTION_HINTS[k]} className="cursor-help text-[9px] font-bold text-gray-400 border border-gray-400 rounded-full w-3.5 h-3.5 inline-flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity">
                      ?
                    </span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={config.retention[k]}
                    onChange={(e) =>
                      update("retention", { ...config.retention, [k]: Number(e.target.value) })
                    }
                    className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs"
                  />
                </label>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">Ticket pattern (regex)</h2>
            <input
              value={config.ticket_pattern}
              onChange={(e) => update("ticket_pattern", e.target.value)}
              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 w-full max-w-md font-mono text-xs"
              placeholder="[A-Z]+-\d+"
            />
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">WebUI scheduler</h2>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.webui_scheduler.enabled}
                onChange={(e) =>
                  update("webui_scheduler", { ...config.webui_scheduler, enabled: e.target.checked })
                }
              />
              Enable scheduled mechanical distillation
            </label>
            <div className="grid grid-cols-2 gap-3 max-w-md mt-2">
              <label className="flex flex-col text-xs">
                <span className="text-[var(--text-secondary)]">mechanical_distill_interval_minutes</span>
                <input
                  type="number"
                  min={1}
                  value={config.webui_scheduler.mechanical_distill_interval_minutes}
                  onChange={(e) =>
                    update("webui_scheduler", {
                      ...config.webui_scheduler,
                      mechanical_distill_interval_minutes: Number(e.target.value),
                    })
                  }
                  className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs"
                />
              </label>
              <label className="flex flex-col text-xs">
                <span className="text-[var(--text-secondary)]">housekeep_interval_hours</span>
                <input
                  type="number"
                  min={1}
                  value={config.webui_scheduler.housekeep_interval_hours}
                  onChange={(e) =>
                    update("webui_scheduler", {
                      ...config.webui_scheduler,
                      housekeep_interval_hours: Number(e.target.value),
                    })
                  }
                  className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs"
                />
              </label>
            </div>
          </section>

          <SaveBar
            count={unsaved}
            errorCount={0}
            onSave={save}
            onDiscard={discard}
          />
        </>
      )}
    </div>
  );
}
