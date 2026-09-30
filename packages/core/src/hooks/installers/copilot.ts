import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import type { Installer, InstallCtx } from "./types.js";
import { emitCommand, psEmitCommand, isOwned, readJsonConfig, writeJsonConfig } from "./json-config.js";

const EVENTS = ["userPromptSubmitted", "subagentStop", "postToolUse"];
// Copilot reads $COPILOT_HOME/hooks when set; a container host install can't see the host's environment, so it always uses <home>/.copilot.
const baseDir = (ctx: InstallCtx): string => (!ctx.hostDataDir && process.env.COPILOT_HOME ? process.env.COPILOT_HOME : join(ctx.home, ".copilot"));
const configPath = (ctx: InstallCtx) => join(baseDir(ctx), "hooks", "kontexta.json");

export const copilotInstaller: Installer = {
  id: "copilot",
  configPath,
  install(ctx) {
    const path = configPath(ctx);
    const hooks: Record<string, unknown> = {};
    // `bash` and `powershell` are the documented per-OS keys; `command` carries the same call for builds that read it.
    for (const ev of EVENTS) {
      const sh = emitCommand(ctx, "copilot", ev);
      hooks[ev] = [{ type: "command", command: sh, bash: sh, powershell: psEmitCommand(ctx, "copilot", ev), timeoutSec: 5 }];
    }
    const changed = writeJsonConfig(path, { version: 1, hooks }, ctx.dryRun);
    return { agent: "copilot", path, changed, notes: ["Copilot main-agent replies are not exposed to hooks yet (agentStop carries only a transcript path); subagent replies, prompts and shell commands are captured."] };
  },
  uninstall(ctx) {
    const path = configPath(ctx);
    if (!existsSync(path)) return { agent: "copilot", path, changed: false, notes: [] };
    if (!ctx.dryRun) unlinkSync(path);
    return { agent: "copilot", path, changed: true, notes: [] };
  },
  status(ctx) {
    const path = configPath(ctx);
    let installed = false; const notes: string[] = [];
    try {
      const hooks = readJsonConfig(path).hooks as Record<string, Array<{ command?: unknown; bash?: unknown; powershell?: unknown }>> | undefined;
      installed = EVENTS.every((ev) => (hooks?.[ev] ?? []).some((h) => isOwned(h?.command) || isOwned(h?.bash) || isOwned(h?.powershell)));
    } catch (e) { notes.push((e as Error).message); }
    return { agent: "copilot", path, installed, notes };
  },
};
