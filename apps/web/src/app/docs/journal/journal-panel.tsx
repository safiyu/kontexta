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
  slug: string;
  root: string;
}

export function JournalPanel() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [config, setConfig] = useState<JournalConfig>(DEFAULTS);
  const [unsaved, setUnsaved] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d: { projects: Project[] }) => {
        if (cancelled) return;
        setProjects(d.projects);
        if (d.projects.length > 0 && projectId === null) {
          setProjectId(d.projects[0].id);
        }
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/journal-config`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.journal) setConfig({ ...DEFAULTS, ...d.journal });
        setUnsaved(0);
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
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
    <div className="space-y-8 max-w-3xl">
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
          className="border rounded px-2 py-1 min-w-[200px]"
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
              className="border rounded px-2 py-1"
            >
              <option value="lenient">Lenient (recommended)</option>
              <option value="strict">Strict — block reads when backlog exists</option>
              <option value="mechanical-only">Mechanical-only — no LLM upgrade</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Strict mode returns a JOURNAL_BACKLOG error on read tools when undistilled events exist.
              Pass <code>journal_bypass: true</code> on a tool call to override.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">Retention (days; 0 = forever)</h2>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              {(["raw_days","mechanical_only_days","narrative_days","archive_cold_after_days","purge_archived_after_days"] as const).map((k) => (
                <label key={k} className="flex flex-col text-sm">
                  <span className="text-gray-500">{k}</span>
                  <input
                    type="number"
                    min={0}
                    value={config.retention[k]}
                    onChange={(e) =>
                      update("retention", { ...config.retention, [k]: Number(e.target.value) })
                    }
                    className="border rounded px-2 py-1"
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
              className="border rounded px-2 py-1 w-full max-w-md font-mono text-sm"
              placeholder="[A-Z]+-\d+"
            />
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">WebUI scheduler</h2>
            <label className="flex items-center gap-2 text-sm">
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
              <label className="flex flex-col text-sm">
                <span className="text-gray-500">mechanical_distill_interval_minutes</span>
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
                  className="border rounded px-2 py-1"
                />
              </label>
              <label className="flex flex-col text-sm">
                <span className="text-gray-500">housekeep_interval_hours</span>
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
                  className="border rounded px-2 py-1"
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
