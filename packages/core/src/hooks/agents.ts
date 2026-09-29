export interface AgentMeta {
  id: AgentId;
  name: string;
  hooksSupported: boolean;
  onboardable: boolean;
}

export const AGENTS = [
  { id: "claude-code", name: "Claude Code", hooksSupported: true, onboardable: true },
  { id: "codex", name: "Codex CLI", hooksSupported: true, onboardable: true },
  { id: "gemini", name: "Gemini CLI", hooksSupported: true, onboardable: true },
  { id: "copilot", name: "GitHub Copilot CLI", hooksSupported: true, onboardable: true },
  { id: "cursor", name: "Cursor", hooksSupported: true, onboardable: true },
  { id: "windsurf", name: "Windsurf", hooksSupported: true, onboardable: false },
  { id: "kiro", name: "Kiro", hooksSupported: false, onboardable: false },
  { id: "cline", name: "Cline", hooksSupported: true, onboardable: true },
  { id: "opencode", name: "OpenCode", hooksSupported: true, onboardable: false },
  { id: "claude-desktop", name: "Claude Desktop", hooksSupported: false, onboardable: false },
  { id: "antigravity", name: "Antigravity", hooksSupported: false, onboardable: true },
  { id: "continue", name: "Continue", hooksSupported: false, onboardable: true },
  { id: "aider", name: "Aider", hooksSupported: false, onboardable: true },
  { id: "hermes", name: "Hermes", hooksSupported: false, onboardable: false },
  { id: "generic", name: "Generic", hooksSupported: false, onboardable: true },
] as const satisfies readonly { id: string; name: string; hooksSupported: boolean; onboardable: boolean }[];

export type AgentId = (typeof AGENTS)[number]["id"];

export function isAgentId(x: string): x is AgentId {
  return AGENTS.some((a) => a.id === x);
}

export function agentMeta(id: string): AgentMeta | undefined {
  return AGENTS.find((a) => a.id === id) as AgentMeta | undefined;
}
