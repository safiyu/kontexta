import type { AgentId } from "../hooks/agents.js";
import type { McpApproval } from "../hooks/registry.js";
import type { ServerEntry, ServerEntryOpts } from "./entry.js";

export interface McpTool { readonly name: string; readonly destructive: boolean }

export interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type Runner = (cmd: string, args: string[]) => RunResult;

export interface McpCtx {
  home: string;
  entry: ServerEntry;
  approval: McpApproval;
  /** What was applied last time; decides whether `prompt` should remove earlier allow rules. */
  previousApproval: McpApproval;
  tools: readonly McpTool[];
  version: string;
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Shell-out hook (Claude Code); tests inject a fake. */
  run?: Runner;
}

export interface McpResult { agent: AgentId; path: string; changed: boolean; notes: string[] }
export interface McpStatus {
  agent: AgentId; path: string; installed: boolean; current: boolean;
  /** The entry on disk, normalised; undefined when absent. */
  entry?: ServerEntry;
  notes: string[];
}

export interface McpInstaller {
  id: AgentId;
  /** Per-agent tweaks to how the server entry is built. */
  entryHints: Pick<ServerEntryOpts, "forceEnv" | "absolute">;
  /** True when this agent can carry an allowlist from `safe`/`all`. */
  supportsApproval: boolean;
  configPath(ctx: McpCtx): string;
  install(ctx: McpCtx): McpResult;
  uninstall(ctx: McpCtx): McpResult;
  status(ctx: McpCtx): McpStatus;
}
