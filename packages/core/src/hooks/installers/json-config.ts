import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync, statSync, chmodSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { stagedEmitterPath } from "../stage.js";
import type { InstallCtx } from "./types.js";

export const OWNED_MARK = "hooks/emit.mjs";

export class MalformedConfigError extends Error {
  constructor(public path: string, cause: unknown) {
    super(`${path} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}); refusing to overwrite it`);
  }
}

const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

export const hostDirOf = (ctx: InstallCtx): string => ctx.hostDataDir ?? ctx.dataDir;

// GUI-launched agents (Cursor, Windsurf, VS Code) often lack the user's shell PATH, so bake the absolute node path; host installs from a container can only use the host's own `node`.
export const nodeCmdOf = (ctx: InstallCtx): string => ctx.nodeCmd ?? (ctx.hostDataDir ? "node" : process.execPath);

export function emitCommand(ctx: InstallCtx, agent: string, event?: string): string {
  const nc = nodeCmdOf(ctx);
  const node = nc === "node" ? "node" : q(nc);
  const parts = [node, q(stagedEmitterPath(hostDirOf(ctx))), "--agent", agent, "--data-dir", q(hostDirOf(ctx))];
  if (event) parts.push("--event", event);
  return parts.join(" ");
}

export function isOwned(command: unknown): boolean {
  return typeof command === "string" && command.includes(OWNED_MARK);
}

export function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("top level is not an object");
    return v as Record<string, unknown>;
  } catch (e) {
    throw new MalformedConfigError(path, e);
  }
}

// A symlink whose target does not exist yet (dotfile managers): write the target so the link survives.
function danglingLinkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    const t = readlinkSync(path);
    return isAbsolute(t) ? t : resolve(dirname(path), t);
  } catch { return null; }
}

export function writeJsonConfig(path: string, value: unknown, dryRun = false): boolean {
  const next = JSON.stringify(value, null, 2) + "\n";
  const exists = existsSync(path);
  const current = exists ? readFileSync(path, "utf8") : null;
  let same = false;
  if (current !== null) { try { same = JSON.stringify(JSON.parse(current)) === JSON.stringify(value); } catch { /* empty or unparsable → rewrite */ } }
  if (same) return false;
  if (dryRun) return true;
  // Write through symlinks (dotfile managers) and keep the target's mode: replacing the path itself would break the link and can widen a 0600 file.
  const real = exists ? realpathSync(path) : danglingLinkTarget(path) ?? path;
  const mode = exists ? statSync(real).mode & 0o777 : 0o644;
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { encoding: "utf8", mode });
  chmodSync(tmp, mode);
  renameSync(tmp, real);
  return true;
}
