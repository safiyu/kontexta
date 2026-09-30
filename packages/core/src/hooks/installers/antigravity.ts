import { join } from "node:path";
import type { Installer, InstallCtx } from "./types.js";
import { emitCommand, isOwned, readJsonConfig, writeJsonConfig } from "./json-config.js";

// Antigravity keeps hooks as named entries ({ name: { Event: [...] } }) in ~/.gemini/config/hooks.json; ours is one namespaced entry.
const ENTRY = "kontexta-journal";

type Handler = { command?: unknown };
type Group = { matcher?: string; hooks?: Handler[] };
type Entry = Record<string, unknown>;

const configPath = (ctx: InstallCtx) => join(ctx.home, ".gemini", "config", "hooks.json");
const asEntry = (v: unknown): Entry | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Entry) : null);
const isOurs = (entry: Entry) => Object.values(entry).some((groups) => Array.isArray(groups) && (groups as Group[]).some((g) => (g?.hooks ?? []).some((h) => isOwned(h?.command))));

// Drop any handler that runs our emitter; an entry left with no events is removed.
function stripOwned(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(cfg)) {
    const entry = asEntry(raw);
    if (!entry || !isOurs(entry)) { out[name] = raw; continue; }
    const kept: Entry = {};
    for (const [k, v] of Object.entries(entry)) {
      if (!Array.isArray(v)) { kept[k] = v; continue; }
      const groups = (v as Group[]).map((g) => ({ ...g, hooks: (g?.hooks ?? []).filter((h) => !isOwned(h?.command)) })).filter((g) => g.hooks.length > 0);
      if (groups.length > 0) kept[k] = groups;
    }
    if (Object.values(kept).some(Array.isArray)) out[name] = kept;
  }
  return out;
}

export const antigravityInstaller: Installer = {
  id: "antigravity",
  configPath,
  install(ctx) {
    const path = configPath(ctx);
    const cfg = readJsonConfig(path);
    const previous = asEntry(cfg[ENTRY]);
    const disabled = previous && isOurs(previous) && previous.enabled === false;
    const next = stripOwned(cfg);
    if (ENTRY in next) throw new Error(`${path} already has a non-kontexta "${ENTRY}" entry; rename it and retry`);
    const entry: Entry = {
      PostToolUse: [{ matcher: "run_command|ask_question", hooks: [{ type: "command", command: emitCommand(ctx, "antigravity"), timeout: 5 }] }],
    };
    if (disabled) entry.enabled = false;
    next[ENTRY] = entry;
    const changed = writeJsonConfig(path, next, ctx.dryRun);
    return { agent: "antigravity", path, changed, notes: ["Antigravity hook payloads carry no prompt or reply text, so only shell commands and questions are captured."] };
  },
  uninstall(ctx) {
    const path = configPath(ctx);
    const cfg = readJsonConfig(path);
    const changed = writeJsonConfig(path, stripOwned(cfg), ctx.dryRun);
    return { agent: "antigravity", path, changed, notes: [] };
  },
  status(ctx) {
    const path = configPath(ctx);
    const notes: string[] = [];
    let installed = false;
    try {
      const entry = asEntry(readJsonConfig(path)[ENTRY]);
      installed = !!entry && isOurs(entry);
    } catch (e) { notes.push((e as Error).message); }
    return { agent: "antigravity", path, installed, notes };
  },
};
