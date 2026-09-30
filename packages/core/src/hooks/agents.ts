export interface AgentMeta {
  id: AgentId;
  name: string;
  hooksSupported: boolean;
  onboardable: boolean;
  /** True when `kontexta connect` can write this agent's MCP config (Phase 1 set). */
  mcpInstallable: boolean;
}

export const AGENTS = [
  { id: "claude-code", name: "Claude Code", hooksSupported: true, onboardable: true, mcpInstallable: true },
  { id: "codex", name: "Codex CLI", hooksSupported: true, onboardable: true, mcpInstallable: true },
  { id: "gemini", name: "Gemini CLI", hooksSupported: true, onboardable: true, mcpInstallable: true },
  { id: "copilot", name: "GitHub Copilot CLI", hooksSupported: true, onboardable: true, mcpInstallable: true },
  { id: "cursor", name: "Cursor", hooksSupported: true, onboardable: true, mcpInstallable: true },
  { id: "windsurf", name: "Windsurf", hooksSupported: true, onboardable: false, mcpInstallable: false },
  { id: "kiro", name: "Kiro", hooksSupported: false, onboardable: false, mcpInstallable: false },
  { id: "cline", name: "Cline", hooksSupported: true, onboardable: true, mcpInstallable: true },
  { id: "opencode", name: "OpenCode", hooksSupported: true, onboardable: false, mcpInstallable: false },
  { id: "claude-desktop", name: "Claude Desktop", hooksSupported: false, onboardable: false, mcpInstallable: true },
  { id: "antigravity", name: "Antigravity", hooksSupported: true, onboardable: true, mcpInstallable: false },
  { id: "continue", name: "Continue", hooksSupported: false, onboardable: true, mcpInstallable: true },
  { id: "aider", name: "Aider", hooksSupported: false, onboardable: true, mcpInstallable: false },
  { id: "hermes", name: "Hermes", hooksSupported: true, onboardable: false, mcpInstallable: true },
  { id: "generic", name: "Generic", hooksSupported: false, onboardable: true, mcpInstallable: false },
] as const satisfies readonly { id: string; name: string; hooksSupported: boolean; onboardable: boolean; mcpInstallable: boolean }[];

export type AgentId = (typeof AGENTS)[number]["id"];

export function isAgentId(x: string): x is AgentId {
  return AGENTS.some((a) => a.id === x);
}

export function agentMeta(id: string): AgentMeta | undefined {
  return AGENTS.find((a) => a.id === id) as AgentMeta | undefined;
}
