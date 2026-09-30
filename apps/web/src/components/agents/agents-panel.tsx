"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useAgents, type AgentInfo, type InstallOutcome } from "@/hooks/use-agents";

function statusText(a: AgentInfo, mode: string): string {
  if (!a.hooks_supported) return "MCP capture only";
  if (!a.enabled) return "-";
  if (a.hooks_verified_at) return `verified · last event ${new Date(a.last_hook_event_at ?? a.hooks_verified_at).toLocaleString()}`;
  if (mode === "docker") return "run the command below on your machine";
  if (a.hooks_installed) return `installed${a.emitter_stale ? " (emitter outdated)" : ""} - waiting for the first event`;
  return "not installed";
}

function outcomeMessage(o: InstallOutcome | null | undefined, verb: "install" | "uninstall"): string {
  if (!o) return "";
  if (!o.ok) return `${verb === "install" ? "Install" : "Uninstall"} failed: ${o.error}`;
  const base = verb === "install" ? (o.changed ? "Hooks installed." : "Hooks already up to date.") : (o.changed ? "Hooks removed; agent turned off." : "Nothing to remove; agent turned off.");
  return o.notes.length > 0 ? `${base} ${o.notes.join(" ")}` : base;
}

export function AgentsPanel() {
  const { state, loading, setEnabled, hooksAction } = useAgents();
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  if (loading && !state) return <p className="text-sm text-[var(--text-secondary)]">Loading agents…</p>;
  if (!state) return <p role="alert" className="text-sm text-[var(--danger)]">Could not load agents.</p>;

  const say = (id: string, msg: string) => setMessages((m) => ({ ...m, [id]: msg }));

  async function onToggle(a: AgentInfo, enabled: boolean) {
    const r = await setEnabled(a.id, enabled);
    if (!r) return say(a.id, "Request failed.");
    if (r.install) return say(a.id, outcomeMessage(r.install, "install"));
    if (r.docker_command) return say(a.id, "Run the command below on your machine to install hooks.");
    say(a.id, r.note ?? "");
  }

  async function onAction(a: AgentInfo, action: "install" | "uninstall") {
    const r = await hooksAction(a.id, action);
    say(a.id, r.outcome ? outcomeMessage(r.outcome, action) : (r.error ?? "Request failed."));
  }

  async function onCopy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500); } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <p className="text-sm text-[var(--text-secondary)]">
        Enable the coding agents you use. Kontexta installs hooks so the journal also captures your prompts, the agent&apos;s replies and the shell commands it runs.
        Agents that are off are ignored everywhere. Per-agent limits: docs/HOOKS.md.
      </p>
      <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded">
        {state.agents.map((a) => (
          <li key={a.id} className="p-3 space-y-2">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                role="switch"
                aria-label={`Enable ${a.name}`}
                checked={a.enabled}
                onChange={(e) => void onToggle(a, e.target.checked)}
              />
              <span className="font-medium text-[var(--text-primary)] w-48">{a.name}</span>
              <span className="flex-1 text-xs text-[var(--text-secondary)]">{statusText(a, state.install_mode)}</span>
              {a.enabled && a.hooks_supported && state.install_mode !== "docker" && (
                <span className="flex gap-2">
                  <button className="btn btn-sm" aria-label={`Install hooks for ${a.name}`} onClick={() => void onAction(a, "install")}>
                    {a.hooks_installed ? "Reinstall" : "Install"}
                  </button>
                  {a.hooks_installed && (
                    <button className="btn btn-sm btn-destructive" aria-label={`Uninstall hooks for ${a.name}`} onClick={() => void onAction(a, "uninstall")}>
                      Uninstall
                    </button>
                  )}
                </span>
              )}
            </div>
            {a.enabled && a.hooks_supported && state.install_mode === "docker" && state.docker_commands[a.id]?.includes("<DATA_DIR>") && (
              <p className="text-xs text-[var(--text-secondary)]">Replace &lt;DATA_DIR&gt; with the absolute path of your data folder (the one mounted at /app/data).</p>
            )}
            {a.enabled && a.hooks_supported && state.install_mode === "docker" && state.docker_commands[a.id] && (
              <div className="flex items-start gap-2">
                <pre className="flex-1 overflow-x-auto text-xs bg-[var(--bg-secondary)] p-2 rounded">{state.docker_commands[a.id]}</pre>
                <button className="btn btn-icon-sm btn-outline" aria-label={`Copy install command for ${a.name}`} onClick={() => void onCopy(a.id, state.docker_commands[a.id])}>
                  {copied === a.id ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
                </button>
              </div>
            )}
            {messages[a.id] && <p className="text-xs text-[var(--text-secondary)]" role="status">{messages[a.id]}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
