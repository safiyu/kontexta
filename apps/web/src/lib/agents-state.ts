import { hooksStatus, buildHooksBlock, dockerInstallCommand, dockerConnectCommand, mcpStatus, KXTA_TOOLS, detectInstallMode, type HookStatusRow, type HooksAlert, type InstallMode, type McpApproval } from "kxta-core";
import { resolveManualEntrypoint } from "@/lib/manual-entrypoint";
import { DATA_DIR } from "@/lib/db-init";
import { currentVersion } from "@/lib/app-version";

// currentVersion() falls back to "0.0.0" when package.json is unreadable; an image tag of "latest" is more useful than that.
const imageVersion = (): string => { const v = currentVersion(); return v === "0.0.0" ? "latest" : v; };

export const hooksHome = (): string | undefined => process.env.KONTEXTA_HOOKS_HOME || undefined;
export const hostDataDir = (): string | null => process.env.KONTEXTA_HOST_DATA_DIR || null;
export const installOpts = () => ({ home: hooksHome(), dataDir: DATA_DIR });
export const dockerCommandFor = (agent: string): string => dockerInstallCommand({ agent, version: imageVersion(), hostDataDir: hostDataDir() });

export const mcpOpts = (approval?: McpApproval) => ({
  home: hooksHome(), dataDir: DATA_DIR, hostDataDir: hostDataDir() ?? undefined, installMode: detectInstallMode(), version: imageVersion(),
  sourceEntrypoint: resolveManualEntrypoint() ?? undefined, hasLocalCliMcp: process.env.KONTEXTA_INSTALL_HINT === "npm", approval,
});
export const mcpDockerCommandFor = (agent: string, approval?: McpApproval): string => dockerConnectCommand({ agent, version: imageVersion(), hostDataDir: hostDataDir(), approval });

export interface AgentState extends HookStatusRow {
  /** On-disk checks for the MCP registration (the registry flags mcp_installed / mcp_approval come from HookStatusRow). */
  /** The kxta server is in the agent's config, whoever put it there. */
  mcp_present: boolean;
  mcp_current: boolean;
  mcp_stale: boolean;
  mcp_config_path: string | null;
  mcp_approval_supported: boolean;
  mcp_notes: string[];
}

export interface AgentsState {
  install_mode: InstallMode;
  agents: AgentState[];
  alerts: HooksAlert[];
  prompt: string | null;
  docker_commands: Record<string, string>;
  mcp_docker_commands: Record<string, string>;
  mcp_alerts: Array<{ agent: string; name: string }>;
  destructive_tools: string[];
}

export function agentsState(): AgentsState {
  const mode = detectInstallMode();
  const mcp = new Map(mcpStatus(mcpOpts()).map((r) => [r.id, r]));
  const agents: AgentState[] = hooksStatus(installOpts()).map((a) => {
    const m = mcp.get(a.id);
    return { ...a, mcp_present: m?.installed ?? false, mcp_current: m?.current ?? false, mcp_stale: m?.stale ?? false, mcp_config_path: m?.config_path ?? null, mcp_approval_supported: m?.approval_supported ?? false, mcp_notes: m?.notes ?? [] };
  });
  const block = buildHooksBlock({ installMode: mode, version: imageVersion(), hostDataDir: hostDataDir() });
  const docker_commands: Record<string, string> = {};
  if (mode === "docker") for (const a of agents) if (a.hooks_supported) docker_commands[a.id] = dockerCommandFor(a.id);
  const mcp_docker_commands: Record<string, string> = {};
  if (mode === "docker") for (const a of agents) if (a.mcp_supported) mcp_docker_commands[a.id] = mcpDockerCommandFor(a.id);
  const mcp_alerts = agents.filter((a) => a.enabled && a.mcp_supported && !a.mcp_installed && !a.mcp_present).map((a) => ({ agent: a.id, name: a.name }));
  const destructive_tools = KXTA_TOOLS.filter((t) => t.destructive).map((t) => t.name);
  return { install_mode: mode, agents, alerts: block.alerts, prompt: block.prompt, docker_commands, mcp_docker_commands, mcp_alerts, destructive_tools };
}
