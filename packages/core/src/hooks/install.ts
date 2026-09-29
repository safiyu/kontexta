import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { agentMeta, isAgentId } from "./agents.js";
import { listAgents, markInstalled, markUninstalled, type AgentRow } from "./registry.js";
import { EMITTER_VERSION, stageEmitter, syncProjectsSidecar, emitterVersionOnDisk, pruneHookState } from "./stage.js";
import { INSTALLERS } from "./installers/index.js";
import type { InstallCtx } from "./installers/types.js";

export interface HooksOpts { home?: string; dataDir: string; hostDataDir?: string; nodeCmd?: string; projectDir?: string; dryRun?: boolean; registry?: boolean }
export interface AgentHookOutcome { agent: string; ok: boolean; changed: boolean; path: string; notes: string[]; error?: string }
export interface HookStatusRow extends AgentRow {
  config_path: string | null;
  config_present: boolean;
  emitter_version_on_disk: string | null;
  emitter_stale: boolean;
  notes: string[];
}

function ctxOf(opts: HooksOpts): InstallCtx {
  return { home: opts.home ?? homedir(), dataDir: opts.dataDir, hostDataDir: opts.hostDataDir, nodeCmd: opts.nodeCmd, projectDir: opts.projectDir, dryRun: opts.dryRun };
}

function guard(id: string): string | null {
  if (!isAgentId(id)) return `unknown agent: ${id}`;
  if (!agentMeta(id)!.hooksSupported) return `${id} does not support hooks (MCP capture only)`;
  return null;
}

export function installHooks(ids: string[], opts: HooksOpts): AgentHookOutcome[] {
  const ctx = ctxOf(opts);
  const registry = opts.registry !== false;
  let staged = false;
  return ids.map((id) => {
    const err = guard(id);
    if (err) return { agent: id, ok: false, changed: false, path: "", notes: [], error: err };
    try {
      if (!staged && !ctx.dryRun) { stageEmitter(ctx.dataDir); if (registry) syncProjectsSidecar(ctx.dataDir); staged = true; }
      const r = INSTALLERS[id].install(ctx);
      if (registry && !ctx.dryRun && (r.changed || INSTALLERS[id].status(ctx).installed)) markInstalled(id, EMITTER_VERSION);
      return { agent: id, ok: true, changed: r.changed, path: r.path, notes: r.notes };
    } catch (e) {
      return { agent: id, ok: false, changed: false, path: INSTALLERS[id].configPath(ctx), notes: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function uninstallHooks(ids: string[], opts: HooksOpts): AgentHookOutcome[] {
  const ctx = ctxOf(opts);
  return ids.map((id) => {
    const err = guard(id);
    if (err) return { agent: id, ok: false, changed: false, path: "", notes: [], error: err };
    try {
      const r = INSTALLERS[id].uninstall(ctx);
      if (opts.registry !== false && !ctx.dryRun) markUninstalled(id);
      return { agent: id, ok: true, changed: r.changed, path: r.path, notes: r.notes };
    } catch (e) {
      return { agent: id, ok: false, changed: false, path: INSTALLERS[id].configPath(ctx), notes: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function hooksStatus(opts: HooksOpts): HookStatusRow[] {
  const ctx = ctxOf(opts);
  const onDisk = emitterVersionOnDisk(ctx.dataDir);
  return listAgents().map((row) => {
    const inst = INSTALLERS[row.id];
    if (!inst) return { ...row, config_path: null, config_present: false, emitter_version_on_disk: onDisk, emitter_stale: false, notes: [] };
    const s = inst.status(ctx);
    return {
      ...row,
      config_path: s.path || null,
      config_present: s.installed || (!!s.path && existsSync(s.path)),
      emitter_version_on_disk: onDisk,
      emitter_stale: row.hooks_installed && onDisk !== EMITTER_VERSION,
      notes: s.notes,
    };
  });
}

export function reconcile(opts: HooksOpts): AgentHookOutcome[] {
  const ctx = ctxOf(opts);
  const stale = emitterVersionOnDisk(ctx.dataDir) !== EMITTER_VERSION;
  const due = listAgents()
    .filter((r) => r.enabled && r.hooks_supported && (!r.hooks_installed || r.hooks_version !== EMITTER_VERSION || stale))
    .map((r) => r.id);
  if (!ctx.dryRun) pruneHookState(ctx.dataDir);
  if (due.length === 0) {
    if (stale && !ctx.dryRun && listAgents().some((r) => r.hooks_installed)) stageEmitter(ctx.dataDir);
    return [];
  }
  return installHooks(due, opts);
}
