import { homedir } from "node:os";
import { resolve } from "node:path";
import { agentMeta, isAgentId } from "../hooks/agents.js";
import type { InstallMode } from "../hooks/install-mode.js";
import { listAgents, markMcpInstalled, markMcpUninstalled, type AgentRow, type McpApproval } from "../hooks/registry.js";
import { defaultDataDir } from "../util/paths.js";
import { buildServerEntry, entryHashOf, entryHashOfSignature, entrySignature, type ServerEntry } from "./entry.js";
import { MCP_INSTALLERS } from "./installers/index.js";
import { KXTA_TOOLS } from "./tools.generated.js";
import type { McpCtx, McpTool, Runner } from "./types.js";

export interface McpOpts {
  home?: string;
  dataDir: string;
  /** Docker only: the host folder behind /app/data (required in docker mode). */
  hostDataDir?: string;
  installMode: InstallMode;
  version: string;
  sourceEntrypoint?: string;
  hasLocalCliMcp?: boolean;
  nodeCmd?: string;
  dryRun?: boolean;
  /** false = never touch the database (docker one-liner runs). */
  registry?: boolean;
  /** One level for every agent, or a level per agent id. */
  approval?: McpApproval | Record<string, McpApproval>;
  tools?: readonly McpTool[];
  run?: Runner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface McpOutcome { agent: string; ok: boolean; changed: boolean; path: string; approval: McpApproval; notes: string[]; error?: string }
export interface McpStatusRow extends AgentRow {
  config_path: string | null;
  installed: boolean;
  current: boolean;
  stale: boolean;
  /** True when this agent can carry a config-file allowlist for safe/all. */
  approval_supported: boolean;
  notes: string[];
}

const toolsOf = (o: McpOpts) => o.tools ?? KXTA_TOOLS;
const requested = (o: McpOpts, id: string): McpApproval => (typeof o.approval === "string" ? o.approval : o.approval?.[id] ?? "prompt");

function entryFor(id: string, o: McpOpts): ServerEntry {
  const hints = MCP_INSTALLERS[id].entryHints;
  return buildServerEntry({
    installMode: o.installMode, version: o.version, dataDir: o.dataDir, hostDataDir: o.hostDataDir,
    isDefaultDir: resolve(o.dataDir) === resolve(defaultDataDir()),
    sourceEntrypoint: o.sourceEntrypoint, hasLocalCliMcp: o.hasLocalCliMcp, nodeCmd: o.nodeCmd, ...hints,
  });
}

function ctxFor(id: string, o: McpOpts, approval: McpApproval, previous: McpApproval): McpCtx {
  return { home: o.home ?? homedir(), entry: entryFor(id, o), approval, previousApproval: previous, tools: toolsOf(o), version: o.version, dryRun: o.dryRun, platform: o.platform, env: o.env, run: o.run };
}

function guard(id: string): string | null {
  if (!isAgentId(id)) return `unknown agent: ${id}`;
  if (!agentMeta(id)!.mcpInstallable || !MCP_INSTALLERS[id]) return `${id} is not supported yet by the MCP installer; use the INSTALL tab snippet`;
  return null;
}

const previousOf = (id: string, o: McpOpts): McpApproval => (o.registry === false ? "prompt" : listAgents().find((r) => r.id === id)?.mcp_approval ?? "prompt");

export function installMcp(ids: string[], o: McpOpts): McpOutcome[] {
  return ids.map((id): McpOutcome => {
    const err = guard(id);
    if (err) return { agent: id, ok: false, changed: false, path: "", approval: "prompt", notes: [], error: err };
    const inst = MCP_INSTALLERS[id];
    const wanted = requested(o, id);
    const applied: McpApproval = inst.supportsApproval ? wanted : "prompt";
    const extra = wanted !== "prompt" && !inst.supportsApproval ? [`${agentMeta(id)!.name} has no config-file allowlist; approve kxta tools in the app itself.`] : [];
    try {
      const ctx = ctxFor(id, o, applied, previousOf(id, o));
      const r = inst.install(ctx);
      if (o.registry !== false && !o.dryRun) markMcpInstalled(id, entrySignature(ctx.entry, applied, toolsOf(o).map((t) => t.name)), applied);
      return { agent: id, ok: true, changed: r.changed, path: r.path, approval: applied, notes: [...r.notes, ...extra] };
    } catch (e) {
      return { agent: id, ok: false, changed: false, path: "", approval: applied, notes: extra, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function uninstallMcp(ids: string[], o: McpOpts): McpOutcome[] {
  return ids.map((id): McpOutcome => {
    const err = guard(id);
    if (err) return { agent: id, ok: false, changed: false, path: "", approval: "prompt", notes: [], error: err };
    try {
      const r = MCP_INSTALLERS[id].uninstall(ctxFor(id, o, "prompt", previousOf(id, o)));
      if (o.registry !== false && !o.dryRun) markMcpUninstalled(id);
      return { agent: id, ok: true, changed: r.changed, path: r.path, approval: "prompt", notes: r.notes };
    } catch (e) {
      return { agent: id, ok: false, changed: false, path: "", approval: "prompt", notes: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function mcpStatus(o: McpOpts): McpStatusRow[] {
  return listAgents().map((row) => {
    const inst = MCP_INSTALLERS[row.id];
    if (!row.mcp_supported || !inst) return { ...row, config_path: null, installed: false, current: false, stale: false, approval_supported: false, notes: [] };
    try {
      const ctx = ctxFor(row.id, o, row.mcp_approval, row.mcp_approval);
      const s = inst.status(ctx);
      const sig = entrySignature(ctx.entry, row.mcp_approval, toolsOf(o).map((t) => t.name));
      return { ...row, config_path: s.path || null, installed: s.installed, current: s.current, stale: row.mcp_installed && row.mcp_version !== sig, approval_supported: inst.supportsApproval, notes: s.notes };
    } catch (e) {
      return { ...row, config_path: null, installed: false, current: false, stale: false, approval_supported: inst.supportsApproval, notes: [(e as Error).message] };
    }
  });
}

// Refreshes registrations we made (entry or tool list changed). It never creates one, never rewrites an entry the user edited after our install, and never re-adds one the user removed (the registry is corrected instead). Containers cannot edit host files, so docker mode never reconciles.
export function reconcileMcp(o: McpOpts): McpOutcome[] {
  if (o.installMode === "docker") return [];
  const due: Record<string, McpApproval> = {};
  for (const r of listAgents()) {
    if (!r.enabled || !r.mcp_supported || !r.mcp_installed || !MCP_INSTALLERS[r.id]) continue;
    let desired: string;
    let onDisk: { installed: boolean; entry?: ServerEntry };
    try {
      desired = entrySignature(entryFor(r.id, o), r.mcp_approval, toolsOf(o).map((t) => t.name));
      onDisk = MCP_INSTALLERS[r.id].status(ctxFor(r.id, o, r.mcp_approval, r.mcp_approval));
    } catch { continue; }
    if (!onDisk.installed) { if (!o.dryRun && o.registry !== false) markMcpUninstalled(r.id); continue; }
    if (onDisk.entry && entryHashOf(onDisk.entry) !== entryHashOfSignature(r.mcp_version ?? "")) continue;
    if (r.mcp_version !== desired) due[r.id] = r.mcp_approval;
  }
  const ids = Object.keys(due);
  return ids.length === 0 ? [] : installMcp(ids, { ...o, approval: due });
}
