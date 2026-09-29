import {
  getDataDir, buildHooksBlock, detectInstallMode, installHooks, setEnabled, syncAgentRows, isAgentId, agentMeta, dockerInstallCommand,
  type HooksBlock, type AgentHookOutcome,
} from "kxta-core";

const hostDir = (): string | null => process.env.KONTEXTA_HOST_DATA_DIR ?? null;

export function currentHooksBlock(version: string): HooksBlock | null {
  try {
    const block = buildHooksBlock({ installMode: detectInstallMode(), version, hostDataDir: hostDir() });
    return block.alerts.length > 0 ? block : null;
  } catch {
    return null;
  }
}

export interface HooksInstallResult {
  agent: string; mode: string; enabled: boolean;
  outcome?: AgentHookOutcome; docker_command?: string; note?: string; error?: string;
}

export function enableAndInstallHooks(agent: string, version: string): HooksInstallResult {
  const mode = detectInstallMode();
  if (!isAgentId(agent)) return { agent, mode, enabled: false, error: `unknown agent: ${agent}` };
  const meta = agentMeta(agent)!;
  syncAgentRows();
  setEnabled(agent, true);
  if (!meta.hooksSupported) return { agent, mode, enabled: true, note: `${meta.name} has no hook API — MCP capture only.` };
  if (mode === "docker") return { agent, mode, enabled: true, docker_command: dockerInstallCommand({ agent, version, hostDataDir: hostDir() }) };
  // KONTEXTA_HOOKS_HOME lets an MCP running in a container/SSH session point at the home whose agent configs matter.
  const [outcome] = installHooks([agent], { dataDir: getDataDir(), home: process.env.KONTEXTA_HOOKS_HOME || undefined });
  return { agent, mode, enabled: true, outcome };
}
