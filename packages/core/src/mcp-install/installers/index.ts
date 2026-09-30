import type { McpInstaller } from "../types.js";
import { claudeCodeMcpInstaller } from "./claude-code.js";
import { codexMcpInstaller } from "./codex.js";
import { continueMcpInstaller } from "./continue.js";
import { hermesMcpInstaller } from "./hermes.js";
import { claudeDesktopMcpInstaller, clineMcpInstaller, copilotMcpInstaller, cursorMcpInstaller, geminiMcpInstaller } from "./json-servers.js";

export const MCP_INSTALLERS: Record<string, McpInstaller> = {
  "claude-code": claudeCodeMcpInstaller,
  "claude-desktop": claudeDesktopMcpInstaller,
  continue: continueMcpInstaller,
  hermes: hermesMcpInstaller,
  codex: codexMcpInstaller,
  copilot: copilotMcpInstaller,
  cursor: cursorMcpInstaller,
  cline: clineMcpInstaller,
  gemini: geminiMcpInstaller,
};
