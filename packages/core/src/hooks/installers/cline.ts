import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import type { Installer, InstallCtx } from "./types.js";
import { emitCommand } from "./json-config.js";

const MARK = "# kontexta-hooks";
const HOOKS = ["UserPromptSubmit", "PostToolUse"];
const dirOf = (ctx: InstallCtx) => join(ctx.home, "Documents", "Cline", "Hooks");
const shim = (ctx: InstallCtx) => `#!/bin/sh\n${MARK}\nexec ${emitCommand(ctx, "cline")}\n`;
const ours = (p: string) => existsSync(p) && readFileSync(p, "utf8").includes(MARK);

export const clineInstaller: Installer = {
  id: "cline",
  configPath: (ctx) => dirOf(ctx),
  install(ctx) {
    const notes: string[] = ["Cline has no turn-end hook yet; prompts and shell commands are captured, replies are not."];
    let changed = false;
    if (!ctx.dryRun) mkdirSync(dirOf(ctx), { recursive: true });
    for (const name of HOOKS) {
      const p = join(dirOf(ctx), name);
      if (existsSync(p) && !ours(p)) { notes.push(`${name}: an existing non-kontexta hook is present; left untouched.`); continue; }
      const body = shim(ctx);
      if (existsSync(p) && readFileSync(p, "utf8") === body) continue;
      if (!ctx.dryRun) { writeFileSync(p, body, "utf8"); chmodSync(p, 0o755); }
      changed = true;
    }
    return { agent: "cline", path: dirOf(ctx), changed, notes };
  },
  uninstall(ctx) {
    let changed = false;
    for (const name of HOOKS) {
      const p = join(dirOf(ctx), name);
      if (ours(p)) { if (!ctx.dryRun) unlinkSync(p); changed = true; }
    }
    return { agent: "cline", path: dirOf(ctx), changed, notes: [] };
  },
  status(ctx) {
    const installed = HOOKS.every((name) => ours(join(dirOf(ctx), name)));
    return { agent: "cline", path: dirOf(ctx), installed, notes: [] };
  },
};
