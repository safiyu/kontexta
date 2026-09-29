import { join } from "node:path";
import type { AgentId } from "../agents.js";
import type { Installer, InstallCtx } from "./types.js";
import { emitCommand, isOwned, readJsonConfig, writeJsonConfig, MalformedConfigError } from "./json-config.js";

export interface FlatSpec { id: AgentId; relPath: string[]; events: string[]; hinted: boolean; version?: number }

type Entry = { command?: unknown };

export function flatInstaller(spec: FlatSpec): Installer {
  const configPath = (ctx: InstallCtx) => join(ctx.home, ...spec.relPath);
  const hooksOf = (cfg: Record<string, unknown>, path: string): Record<string, unknown> => {
    if (cfg.hooks === undefined) return {};
    if (typeof cfg.hooks !== "object" || cfg.hooks === null || Array.isArray(cfg.hooks)) throw new MalformedConfigError(path, '"hooks" is not an object');
    return { ...(cfg.hooks as Record<string, unknown>) };
  };
  const strip = (hooks: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [ev, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) { out[ev] = list; continue; }
      const kept = (list as Entry[]).filter((e) => !isOwned(e?.command));
      if (kept.length > 0) out[ev] = kept;
    }
    return out;
  };
  return {
    id: spec.id,
    configPath,
    install(ctx) {
      const path = configPath(ctx);
      const cfg = readJsonConfig(path);
      const hooks = strip(hooksOf(cfg, path));
      for (const ev of spec.events) {
        hooks[ev] = [...((hooks[ev] as Entry[] | undefined) ?? []), { command: emitCommand(ctx, spec.id, spec.hinted ? ev : undefined) }];
      }
      const next: Record<string, unknown> = { ...cfg, hooks };
      if (spec.version !== undefined && next.version === undefined) next.version = spec.version;
      return { agent: spec.id, path, changed: writeJsonConfig(path, next, ctx.dryRun), notes: [] };
    },
    uninstall(ctx) {
      const path = configPath(ctx);
      const cfg = readJsonConfig(path);
      if (!cfg.hooks) return { agent: spec.id, path, changed: false, notes: [] };
      const hooks = strip(hooksOf(cfg, path));
      const next: Record<string, unknown> = { ...cfg };
      if (Object.keys(hooks).length > 0) next.hooks = hooks; else delete next.hooks;
      return { agent: spec.id, path, changed: writeJsonConfig(path, next, ctx.dryRun), notes: [] };
    },
    status(ctx) {
      const path = configPath(ctx);
      let installed = false; const notes: string[] = [];
      try {
        const hooks = hooksOf(readJsonConfig(path), path);
        installed = spec.events.every((ev) => ((hooks[ev] as Entry[] | undefined) ?? []).some((e) => isOwned(e?.command)));
      } catch (e) { notes.push((e as Error).message); }
      return { agent: spec.id, path, installed, notes };
    },
  };
}

export const cursorInstaller = flatInstaller({
  id: "cursor", relPath: [".cursor", "hooks.json"], version: 1, hinted: false,
  events: ["beforeSubmitPrompt", "afterAgentResponse", "afterShellExecution"],
});

export const windsurfInstaller = flatInstaller({
  id: "windsurf", relPath: [".codeium", "windsurf", "hooks.json"], hinted: true,
  events: ["pre_user_prompt", "post_cascade_response", "post_run_command"],
});
