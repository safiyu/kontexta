import { join } from "node:path";
import type { AgentId } from "../agents.js";
import type { Installer, InstallCtx } from "./types.js";
import { emitCommand, isOwned, readJsonConfig, writeJsonConfig, MalformedConfigError } from "./json-config.js";

export interface GroupedSpec {
  id: AgentId;
  relPath: string[];
  events: Array<{ name: string; matcher?: string; event?: string }>;
  timeoutKey?: string;
  timeoutValue?: number;
  notes?: string[];
}

type Group = { matcher?: string; hooks?: Array<{ type?: string; command?: unknown }> };

function stripOwned(hooks: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { out[ev] = groups; continue; }
    const kept = (groups as Group[]).map((g) => {
      if (!g || !Array.isArray(g.hooks)) return g;
      return { ...g, hooks: g.hooks.filter((h) => !isOwned(h?.command)) };
    }).filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (kept.length > 0) out[ev] = kept;
  }
  return out;
}

export function groupedInstaller(spec: GroupedSpec): Installer {
  const configPath = (ctx: InstallCtx) => join(ctx.home, ...spec.relPath);
  const hooksOf = (cfg: Record<string, unknown>, path: string): Record<string, unknown> => {
    if (cfg.hooks === undefined) return {};
    if (typeof cfg.hooks !== "object" || cfg.hooks === null || Array.isArray(cfg.hooks)) throw new MalformedConfigError(path, '"hooks" is not an object');
    return cfg.hooks as Record<string, unknown>;
  };

  return {
    id: spec.id,
    configPath,
    install(ctx) {
      const path = configPath(ctx);
      const cfg = readJsonConfig(path);
      const hooks = stripOwned(hooksOf(cfg, path));
      for (const e of spec.events) {
        const entry: Record<string, unknown> = { type: "command", command: emitCommand(ctx, spec.id, e.event) };
        if (spec.timeoutKey) entry[spec.timeoutKey] = spec.timeoutValue ?? 5;
        const group: Group = e.matcher ? { matcher: e.matcher, hooks: [entry] } : { hooks: [entry] };
        hooks[e.name] = [...((hooks[e.name] as Group[] | undefined) ?? []), group];
      }
      const changed = writeJsonConfig(path, { ...cfg, hooks }, ctx.dryRun);
      return { agent: spec.id, path, changed, notes: [...(spec.notes ?? [])] };
    },
    uninstall(ctx) {
      const path = configPath(ctx);
      const cfg = readJsonConfig(path);
      if (!cfg.hooks) return { agent: spec.id, path, changed: false, notes: [] };
      const hooks = stripOwned(hooksOf(cfg, path));
      const next: Record<string, unknown> = { ...cfg };
      if (Object.keys(hooks).length > 0) next.hooks = hooks; else delete next.hooks;
      const changed = writeJsonConfig(path, next, ctx.dryRun);
      return { agent: spec.id, path, changed, notes: [] };
    },
    status(ctx) {
      const path = configPath(ctx);
      let installed = false; const notes: string[] = [];
      try {
        const hooks = hooksOf(readJsonConfig(path), path);
        installed = spec.events.every((e) => ((hooks[e.name] as Group[] | undefined) ?? []).some((g) => (g?.hooks ?? []).some((h) => isOwned(h?.command))));
      } catch (e) { notes.push((e as Error).message); }
      return { agent: spec.id, path, installed, notes };
    },
  };
}
