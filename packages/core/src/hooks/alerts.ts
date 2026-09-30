import { alerts as registryAlerts } from "./registry.js";
import { agentMeta } from "./agents.js";
import type { InstallMode } from "./install-mode.js";

export interface HooksAlert { agent: string; name: string; installed: boolean; verified_at: string | null; docker_command?: string }
export interface HooksBlock { install_mode: InstallMode; alerts: HooksAlert[]; prompt: string | null }

// A relative host path (compose's ./kontexta-data default) can't be resolved from inside the container, so it is treated as unknown.
export const isAbsoluteHostPath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
// Escape for use inside double quotes in a POSIX shell.
export const dq = (s: string): string => s.replace(/(["\\$`])/g, "\\$1");

export function dockerInstallCommand(o: { agent: string; version: string; hostDataDir?: string | null }): string {
  const dir = o.hostDataDir && isAbsoluteHostPath(o.hostDataDir) ? dq(o.hostDataDir) : "<DATA_DIR>";
  return `docker run --rm -v "$HOME":/host -v "${dir}":/app/data safiyu/kontexta:${o.version} hooks install --home /host --host-data-dir "${dir}" --no-db --agent ${o.agent}`;
}

export function buildHooksBlock(o: { installMode: InstallMode; version: string; hostDataDir?: string | null; now?: Date }): HooksBlock {
  const alerts: HooksAlert[] = registryAlerts(o.now).map((r) => ({
    agent: r.id, name: r.name, installed: r.hooks_installed, verified_at: r.hooks_verified_at,
    ...(o.installMode === "docker" ? { docker_command: dockerInstallCommand({ agent: r.id, version: o.version, hostDataDir: o.hostDataDir }) } : {}),
  }));
  if (alerts.length === 0) return { install_mode: o.installMode, alerts, prompt: null };

  const missing = alerts.filter((a) => !a.installed);
  const silent = alerts.filter((a) => a.installed);
  const lines: string[] = [];
  if (missing.length > 0) {
    const names = missing.map((a) => a.name).join(", ");
    if (o.installMode === "docker") {
      lines.push(`Kontexta can capture your conversation and shell commands for ${names}. The container cannot edit files on your machine, so run the docker command from the dashboard's Configure → AGENTS tab (or hooks.alerts[].docker_command) on the host.`);
    } else {
      // admin.onboard_agent only accepts agents that have a rules-file scaffold; the rest must use the CLI.
      const viaTool = missing.filter((a) => agentMeta(a.agent)?.onboardable);
      const cliOnly = missing.filter((a) => !agentMeta(a.agent)?.onboardable);
      const install = viaTool.length > 0
        ? `After the user agrees, call admin.onboard_agent with hooks:true, confirm:true and target_agent set to one of (${viaTool.map((a) => a.agent).join(" | ")}), or run \`kontexta hooks install --agent <id>\`.`
        : "After the user agrees, run `kontexta hooks install --agent <id>`.";
      const cli = cliOnly.length > 0
        ? ` For ${cliOnly.map((a) => a.name).join(", ")}, run ${cliOnly.map((a) => `\`kontexta hooks install --agent ${a.agent}\``).join(" / ")} (onboarding does not cover ${cliOnly.length > 1 ? "them" : "it"}).`
        : "";
      lines.push(`Kontexta can capture your conversation and shell commands for ${names}. Install their hooks now? ${install}${cli}`);
    }
  }
  if (silent.length > 0) {
    lines.push(`Hooks for ${silent.map((a) => a.name).join(", ")} are installed but no events have arrived in over a week — run \`kontexta hooks status\` to check.`);
  }
  return { install_mode: o.installMode, alerts, prompt: lines.join(" ") };
}
