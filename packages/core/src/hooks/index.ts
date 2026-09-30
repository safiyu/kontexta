export { AGENTS, agentMeta, isAgentId } from "./agents.js";
export type { AgentId, AgentMeta } from "./agents.js";
export { syncAgentRows, listAgents, setEnabled, markInstalled, markUninstalled, markVerified, alerts, markMcpInstalled, markMcpUninstalled, setMcpApproval, mcpAlerts, MCP_APPROVALS } from "./registry.js";
export type { AgentRow, McpApproval } from "./registry.js";
export {
  EMITTER_VERSION, emitterVersionOf, emitterSourcePath, stagedEmitterPath, stageEmitter, emitterVersionOnDisk, syncProjectsSidecar, pruneHookState,
} from "./stage.js";
export { installHooks, uninstallHooks, hooksStatus, reconcile } from "./install.js";
export type { HooksOpts, AgentHookOutcome, HookStatusRow } from "./install.js";
export { INSTALLERS, MalformedConfigError, emitCommand } from "./installers/index.js";
export type { Installer, InstallCtx, InstallResult, StatusResult } from "./installers/index.js";
export { detectInstallMode } from "./install-mode.js";
export type { InstallMode } from "./install-mode.js";
export { dockerInstallCommand, buildHooksBlock } from "./alerts.js";
export type { HooksAlert, HooksBlock } from "./alerts.js";
