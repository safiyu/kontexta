"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export const AGENTS_CHANGED_EVENT = "kontexta:agents-changed";

export interface AgentInfo {
  id: string; name: string; enabled: boolean; hooks_supported: boolean; onboardable: boolean;
  hooks_installed: boolean; hooks_version: string | null; hooks_verified_at: string | null; last_hook_event_at: string | null;
  config_present: boolean; emitter_stale: boolean; notes: string[];
  mcp_supported: boolean; mcp_installed: boolean; mcp_approval: McpApproval; mcp_current: boolean; mcp_stale: boolean;
  mcp_config_path: string | null; mcp_approval_supported: boolean; mcp_notes: string[];
}
export type McpApproval = "prompt" | "safe" | "all";
export interface AgentsState {
  install_mode: "docker" | "npm" | "source";
  agents: AgentInfo[];
  alerts: Array<{ agent: string; name: string; installed: boolean; verified_at: string | null }>;
  prompt: string | null;
  docker_commands: Record<string, string>;
  mcp_docker_commands: Record<string, string>;
  mcp_alerts: Array<{ agent: string; name: string }>;
  destructive_tools: string[];
}
export interface McpOutcome { ok: boolean; changed: boolean; approval: McpApproval; error?: string; notes: string[] }
export interface InstallOutcome { ok: boolean; changed: boolean; error?: string; notes: string[] }
export interface ToggleResult { agent: string; enabled: boolean; install: InstallOutcome | null; docker_command: string | null; note: string | null }

const notifyChanged = () => window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));

export function useAgents() {
  const [state, setState] = useState<AgentsState | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        if (mine === seq.current) setState(Array.isArray(data?.agents) ? (data as AgentsState) : null);
      } else if (mine === seq.current) setState(null);
    } catch {
      if (mine === seq.current) setState(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => { void refresh(); };
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const setEnabled = useCallback(async (id: string, enabled: boolean): Promise<ToggleResult | null> => {
    try {
      const res = await fetch(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      if (!res.ok) return null;
      const result = (await res.json()) as ToggleResult;
      notifyChanged();
      return result;
    } catch { return null; }
  }, []);

  const hooksAction = useCallback(async (id: string, action: "install" | "uninstall") => {
    try {
      const res = await fetch(`/api/agents/${id}/hooks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const json = await res.json().catch(() => ({}));
      notifyChanged();
      return { ok: res.ok, status: res.status, ...json } as { ok: boolean; status: number; outcome?: InstallOutcome; docker_command?: string; error?: string };
    } catch { return { ok: false, status: 0, error: "Request failed" }; }
  }, []);

  const mcpAction = useCallback(async (id: string, action: "install" | "uninstall", approval: McpApproval = "prompt") => {
    try {
      const res = await fetch(`/api/agents/${id}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, approval }) });
      const json = await res.json().catch(() => ({}));
      notifyChanged();
      return { ok: res.ok, status: res.status, ...json } as { ok: boolean; status: number; outcome?: McpOutcome; docker_command?: string; error?: string };
    } catch { return { ok: false, status: 0, error: "Request failed" } as { ok: boolean; status: number; outcome?: McpOutcome; docker_command?: string; error?: string }; }
  }, []);

  return { state, loading, refresh, setEnabled, hooksAction, mcpAction };
}
