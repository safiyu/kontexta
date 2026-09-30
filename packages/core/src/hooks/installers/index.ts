import type { Installer } from "./types.js";
import { claudeCodeInstaller } from "./claude-code.js";
import { geminiInstaller } from "./gemini.js";
import { codexInstaller } from "./codex.js";
import { cursorInstaller, windsurfInstaller } from "./flat.js";
import { copilotInstaller } from "./copilot.js";
import { clineInstaller } from "./cline.js";
import { opencodeInstaller } from "./opencode.js";
import { antigravityInstaller } from "./antigravity.js";
import { hermesInstaller } from "./hermes.js";

export const INSTALLERS: Record<string, Installer> = {
  "claude-code": claudeCodeInstaller,
  gemini: geminiInstaller,
  codex: codexInstaller,
  copilot: copilotInstaller,
  cursor: cursorInstaller,
  windsurf: windsurfInstaller,
  cline: clineInstaller,
  opencode: opencodeInstaller,
  antigravity: antigravityInstaller,
  hermes: hermesInstaller,
};
export type { Installer, InstallCtx, InstallResult, StatusResult } from "./types.js";
export { MalformedConfigError, emitCommand, isOwned } from "./json-config.js";
