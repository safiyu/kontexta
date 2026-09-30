import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId } from "../../hooks/agents.js";
import { MalformedConfigError, readJsonConfig } from "../../hooks/installers/json-config.js";
import { writeJsonWithBackup } from "../write.js";
import { approvedTools, rewriteRules } from "../rules.js";
import type { McpCtx, McpInstaller, McpResult, McpStatus } from "../types.js";
import { sameEntry } from "../entry.js";

export const SERVER_KEY = "kxta";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export type ConfigApprovalSpec = NonNullable<JsonServersSpec["configApproval"]>;

export interface JsonServersSpec {
  id: AgentId;
  label: string;
  /** Config file path; may throw when the agent does not exist on this platform. */
  path: (ctx: McpCtx) => string;
  entryHints?: McpInstaller["entryHints"];
  /** Documented defaults for keys the user has not set (existing values are never overwritten). */
  entryExtras?: Record<string, unknown>;
  /** Applies the approval level to the whole config (Gemini allow rules). */
  configApproval?: { isOurs: (rule: string) => boolean; rule: (toolName: string) => string; wildcard: string };
  /** Applies the approval level inside the server entry (Cline alwaysAllow). */
  entryApproval?: boolean;
}

function serversOf(cfg: Json, path: string): Json {
  if (cfg.mcpServers === undefined) return {};
  if (!isObj(cfg.mcpServers)) throw new MalformedConfigError(path, '"mcpServers" is not an object');
  return cfg.mcpServers;
}

export function applyConfigApproval(cfg: Json, spec: NonNullable<JsonServersSpec["configApproval"]>, ctx: McpCtx, path: string): Json {
  const perms = cfg.permissions;
  if (perms !== undefined && !isObj(perms)) throw new MalformedConfigError(path, '"permissions" is not an object');
  const allowRaw = perms?.allow;
  if (allowRaw !== undefined && !Array.isArray(allowRaw)) throw new MalformedConfigError(path, '"permissions.allow" is not a list');
  const existing = (allowRaw ?? []) as string[];
  const tools = approvedTools(ctx.approval, ctx.tools);
  const desired = tools === null ? null : tools === "*" ? [spec.wildcard] : tools.map(spec.rule);
  const next = rewriteRules(existing, spec.isOurs, desired, ctx.previousApproval);
  if (next === null) return cfg;
  const permissions: Json = { ...(perms ?? {}) };
  if (next.length > 0) permissions.allow = next; else delete permissions.allow;
  const out: Json = { ...cfg };
  if (Object.keys(permissions).length > 0) out.permissions = permissions; else delete out.permissions;
  return out;
}

export function jsonServersInstaller(spec: JsonServersSpec): McpInstaller {
  return {
    id: spec.id,
    entryHints: spec.entryHints ?? {},
    supportsApproval: !!spec.configApproval || !!spec.entryApproval,
    configPath: spec.path,
    install(ctx): McpResult {
      const path = spec.path(ctx);
      if (!existsSync(dirname(path))) throw new Error(`${spec.label} config folder not found (${dirname(path)}); open ${spec.label} once, or add the server by hand from the INSTALL tab`);
      let cfg = readJsonConfig(path);
      const servers = { ...serversOf(cfg, path) };
      const prior = isObj(servers[SERVER_KEY]) ? (servers[SERVER_KEY] as Json) : {};
      const next: Json = { ...prior, command: ctx.entry.command, args: ctx.entry.args };
      if (ctx.entry.env) next.env = ctx.entry.env; else delete next.env;
      for (const [k, v] of Object.entries(spec.entryExtras ?? {})) if (!(k in next)) next[k] = v;
      if (spec.entryApproval) {
        const tools = approvedTools(ctx.approval, ctx.tools);
        if (tools === null) { if (ctx.previousApproval !== "prompt") delete next.alwaysAllow; }
        else next.alwaysAllow = tools === "*" ? ctx.tools.map((t) => t.name) : tools;
      }
      servers[SERVER_KEY] = next;
      cfg = { ...cfg, mcpServers: servers };
      if (spec.configApproval) cfg = applyConfigApproval(cfg, spec.configApproval, ctx, path);
      const changed = writeJsonWithBackup(path, cfg, ctx.dryRun);
      return { agent: spec.id, path, changed, notes: [] };
    },
    uninstall(ctx): McpResult {
      const path = spec.path(ctx);
      if (!existsSync(path)) return { agent: spec.id, path, changed: false, notes: [] };
      let cfg = readJsonConfig(path);
      const servers = { ...serversOf(cfg, path) };
      delete servers[SERVER_KEY];
      cfg = { ...cfg };
      if (Object.keys(servers).length > 0) cfg.mcpServers = servers; else delete cfg.mcpServers;
      if (spec.configApproval) cfg = applyConfigApproval(cfg, spec.configApproval, { ...ctx, approval: "prompt", previousApproval: "all" }, path);
      return { agent: spec.id, path, changed: writeJsonWithBackup(path, cfg, ctx.dryRun), notes: [] };
    },
    status(ctx): McpStatus {
      let path = "";
      const notes: string[] = [];
      try {
        path = spec.path(ctx);
        const existing = serversOf(readJsonConfig(path), path)[SERVER_KEY];
        return { agent: spec.id, path, installed: existing !== undefined, current: sameEntry(existing, ctx.entry), notes };
      } catch (e) {
        notes.push((e as Error).message);
        return { agent: spec.id, path, installed: false, current: false, notes };
      }
    },
  };
}

const ruleOf = (tool: string) => `mcp(${SERVER_KEY}/${tool})`;

export const cursorMcpInstaller = jsonServersInstaller({ id: "cursor", label: "Cursor", path: (c) => join(c.home, ".cursor", "mcp.json"), entryHints: { absolute: true }, entryExtras: { type: "stdio" } });
// Copilot CLI only inherits PATH into MCP servers, so the data dir is always spelled out.
export const copilotMcpInstaller = jsonServersInstaller({
  id: "copilot", label: "GitHub Copilot CLI", entryHints: { forceEnv: true }, entryExtras: { type: "local", tools: ["*"] },
  path: (c) => join((c.env ?? process.env).COPILOT_HOME || join(c.home, ".copilot"), "mcp-config.json"),
});
export const clineMcpInstaller = jsonServersInstaller({ id: "cline", label: "Cline", path: (c) => join(c.home, ".cline", "mcp_settings.json"), entryApproval: true });
export const geminiMcpInstaller = jsonServersInstaller({
  id: "gemini", label: "Gemini CLI", path: (c) => join(c.home, ".gemini", "settings.json"),
  configApproval: { isOurs: (r) => r === `mcp(${SERVER_KEY}/*)` || r.startsWith(`mcp(${SERVER_KEY}/`), rule: ruleOf, wildcard: `mcp(${SERVER_KEY}/*)` },
});
export const claudeDesktopMcpInstaller = jsonServersInstaller({
  id: "claude-desktop", label: "Claude Desktop", entryHints: { absolute: true },
  path: (c) => {
    const platform = c.platform ?? process.platform;
    if (platform === "darwin") return join(c.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (platform === "win32") return join((c.env ?? process.env).APPDATA ?? join(c.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    throw new Error("Claude Desktop is not available on Linux");
  },
});
