import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import type { Installer, InstallCtx } from "./types.js";
import { stagedEmitterPath } from "../stage.js";
import { hostDirOf, nodeCmdOf } from "./json-config.js";

const MARK = "// kontexta-hooks";
const configPath = (ctx: InstallCtx) => join(ctx.home, ".config", "opencode", "plugins", "kontexta.ts");

function pluginSource(ctx: InstallCtx): string {
  const emit = JSON.stringify(stagedEmitterPath(hostDirOf(ctx)));
  const dataDir = JSON.stringify(hostDirOf(ctx));
  const node = JSON.stringify(nodeCmdOf(ctx));
  return `${MARK}
// Installed by kontexta. Forwards prompts and shell commands to the kontexta journal emitter.
import { spawn } from "node:child_process";

const EMIT = ${emit};
const DATA_DIR = ${dataDir};
const NODE = ${node};

function send(payload: Record<string, unknown>): void {
  try {
    const child = spawn(NODE, [EMIT, "--agent", "opencode", "--data-dir", DATA_DIR], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  } catch {}
}

export const KontextaHooks = async ({ directory }: { directory?: string } = {}) => ({
  "chat.message": async (input: any, output: any) => {
    const parts = Array.isArray(output?.parts) ? output.parts : [];
    const text = parts.filter((p: any) => p && p.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\\n");
    if (text) send({ kontexta_event: "user_prompt", session_id: input?.sessionID, cwd: directory ?? process.cwd(), text });
  },
  "tool.execute.after": async (input: any, _output: any) => {
    const command = input?.args?.command;
    if (input?.tool === "bash" && typeof command === "string") send({ kontexta_event: "shell", session_id: input?.sessionID, cwd: directory ?? process.cwd(), command });
  },
});

export default KontextaHooks;
`;
}

export const opencodeInstaller: Installer = {
  id: "opencode",
  configPath,
  install(ctx) {
    const path = configPath(ctx);
    const body = pluginSource(ctx);
    const notes = ["OpenCode replies are not available to plugins; prompts and shell commands are captured."];
    if (existsSync(path)) {
      const cur = readFileSync(path, "utf8");
      if (!cur.startsWith(MARK)) return { agent: "opencode", path, changed: false, notes: [...notes, "kontexta.ts exists and is not ours; left untouched."] };
      if (cur === body) return { agent: "opencode", path, changed: false, notes };
    }
    if (!ctx.dryRun) { mkdirSync(join(ctx.home, ".config", "opencode", "plugins"), { recursive: true }); writeFileSync(path, body, "utf8"); }
    return { agent: "opencode", path, changed: true, notes };
  },
  uninstall(ctx) {
    const path = configPath(ctx);
    if (!existsSync(path) || !readFileSync(path, "utf8").startsWith(MARK)) return { agent: "opencode", path, changed: false, notes: [] };
    if (!ctx.dryRun) unlinkSync(path);
    return { agent: "opencode", path, changed: true, notes: [] };
  },
  status(ctx) {
    const path = configPath(ctx);
    const installed = existsSync(path) && readFileSync(path, "utf8").startsWith(MARK);
    return { agent: "opencode", path, installed, notes: [] };
  },
};
