import { hooksStatus, buildHooksBlock, dockerInstallCommand, detectInstallMode, type HookStatusRow, type HooksAlert, type InstallMode } from "kxta-core";
import { DATA_DIR } from "@/lib/db-init";
import { currentVersion } from "@/lib/app-version";

// currentVersion() falls back to "0.0.0" when package.json is unreadable; an image tag of "latest" is more useful than that.
const imageVersion = (): string => { const v = currentVersion(); return v === "0.0.0" ? "latest" : v; };

export const hooksHome = (): string | undefined => process.env.KONTEXTA_HOOKS_HOME || undefined;
export const hostDataDir = (): string | null => process.env.KONTEXTA_HOST_DATA_DIR || null;
export const installOpts = () => ({ home: hooksHome(), dataDir: DATA_DIR });
export const dockerCommandFor = (agent: string): string => dockerInstallCommand({ agent, version: imageVersion(), hostDataDir: hostDataDir() });

export interface AgentsState {
  install_mode: InstallMode;
  agents: HookStatusRow[];
  alerts: HooksAlert[];
  prompt: string | null;
  docker_commands: Record<string, string>;
}

export function agentsState(): AgentsState {
  const mode = detectInstallMode();
  const agents = hooksStatus(installOpts());
  const block = buildHooksBlock({ installMode: mode, version: imageVersion(), hostDataDir: hostDataDir() });
  const docker_commands: Record<string, string> = {};
  if (mode === "docker") for (const a of agents) if (a.hooks_supported) docker_commands[a.id] = dockerCommandFor(a.id);
  return { install_mode: mode, agents, alerts: block.alerts, prompt: block.prompt, docker_commands };
}
