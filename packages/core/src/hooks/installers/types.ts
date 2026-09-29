import type { AgentId } from "../agents.js";

export interface InstallCtx {
  home: string;
  dataDir: string;
  hostDataDir?: string;
  nodeCmd?: string;
  projectDir?: string;
  dryRun?: boolean;
}

export interface InstallResult { agent: AgentId; path: string; changed: boolean; notes: string[] }
export interface StatusResult { agent: AgentId; path: string; installed: boolean; notes: string[] }

export interface Installer {
  id: AgentId;
  configPath(ctx: InstallCtx): string;
  install(ctx: InstallCtx): InstallResult;
  uninstall(ctx: InstallCtx): InstallResult;
  status(ctx: InstallCtx): StatusResult;
}
