import { getDatabase } from "../db/index.js";
import { AGENTS, isAgentId } from "./agents.js";

export interface AgentRow {
  id: string;
  name: string;
  enabled: boolean;
  hooks_supported: boolean;
  onboardable: boolean;
  hooks_installed: boolean;
  hooks_version: string | null;
  hooks_installed_at: string | null;
  hooks_verified_at: string | null;
  last_hook_event_at: string | null;
}

interface RawRow {
  id: string; enabled: number; hooks_supported: number; hooks_installed: number;
  hooks_version: string | null; hooks_installed_at: string | null;
  hooks_verified_at: string | null; last_hook_event_at: string | null;
}

const UNVERIFIED_ALERT_DAYS = 7;

export function syncAgentRows(): void {
  const db = getDatabase();
  const up = db.prepare(`
    INSERT INTO agents (id, hooks_supported) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET hooks_supported = excluded.hooks_supported
  `);
  db.transaction(() => { for (const a of AGENTS) up.run(a.id, a.hooksSupported ? 1 : 0); })();
}

export function listAgents(): AgentRow[] {
  const rows = getDatabase().prepare(`SELECT * FROM agents`).all() as RawRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return AGENTS.filter((a) => byId.has(a.id)).map((a) => {
    const r = byId.get(a.id)!;
    return {
      id: r.id, name: a.name,
      enabled: r.enabled === 1, hooks_supported: r.hooks_supported === 1, onboardable: a.onboardable, hooks_installed: r.hooks_installed === 1,
      hooks_version: r.hooks_version, hooks_installed_at: r.hooks_installed_at,
      hooks_verified_at: r.hooks_verified_at, last_hook_event_at: r.last_hook_event_at,
    };
  });
}

function touch(sql: string, ...params: unknown[]): void {
  getDatabase().prepare(sql).run(...params);
}

export function setEnabled(id: string, enabled: boolean): void {
  if (!isAgentId(id)) throw new Error(`unknown agent: ${id}`);
  touch(`UPDATE agents SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, enabled ? 1 : 0, id);
}

export function markInstalled(id: string, version: string): void {
  if (!isAgentId(id)) throw new Error(`unknown agent: ${id}`);
  touch(`UPDATE agents SET hooks_installed = 1, hooks_version = ?, hooks_installed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, version, id);
}

export function markUninstalled(id: string): void {
  if (!isAgentId(id)) throw new Error(`unknown agent: ${id}`);
  // Uninstalling also turns the agent off: "enabled" means hooks are wanted, and reconcile would otherwise reinstall them on the next start.
  touch(`UPDATE agents SET enabled = 0, hooks_installed = 0, hooks_version = NULL, hooks_installed_at = NULL, hooks_verified_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, id);
}

export function markVerified(id: string, ts: string): void {
  if (!isAgentId(id)) return;
  touch(`UPDATE agents SET hooks_verified_at = COALESCE(hooks_verified_at, ?), last_hook_event_at = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, ts, ts, id);
}

export function alerts(now: Date = new Date()): AgentRow[] {
  const cutoff = new Date(now.getTime() - UNVERIFIED_ALERT_DAYS * 86_400_000).toISOString();
  return listAgents().filter((r) =>
    r.enabled && r.hooks_supported &&
    ((!r.hooks_installed && r.hooks_verified_at === null) || (r.hooks_installed && r.hooks_verified_at === null && (r.hooks_installed_at ?? "") < cutoff)),
  );
}
