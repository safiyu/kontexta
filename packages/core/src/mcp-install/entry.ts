import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InstallMode } from "../hooks/install-mode.js";
import type { McpApproval } from "../hooks/registry.js";

export interface ServerEntry { command: string; args: string[]; env?: Record<string, string> }

export interface ServerEntryOpts {
  installMode: InstallMode;
  version: string;
  /** Data dir as the server sees it (the container path for docker). */
  dataDir: string;
  /** Docker only: the host folder mounted at /app/data. */
  hostDataDir?: string;
  isDefaultDir: boolean;
  sourceEntrypoint?: string;
  /** npm: a local `kontexta` install exists, so use its bundled server. */
  hasLocalCliMcp?: boolean;
  /** Always write KONTEXTA_DATA_DIR (agents that strip the environment, e.g. Hermes). */
  forceEnv?: boolean;
  /** Bake absolute node/npx paths: GUI-launched agents often lack the user's shell PATH. */
  absolute?: boolean;
  nodeCmd?: string;
}

function absoluteNpx(nodeCmd: string): string {
  const npx = join(dirname(nodeCmd), process.platform === "win32" ? "npx.cmd" : "npx");
  return existsSync(npx) ? npx : "npx";
}

export function buildServerEntry(o: ServerEntryOpts): ServerEntry {
  const node = o.nodeCmd ?? process.execPath;
  if (o.installMode === "docker") {
    if (!o.hostDataDir) throw new Error("docker install needs the host data folder (--host-data-dir)");
    return { command: "docker", args: ["run", "--rm", "-i", "-v", `${o.hostDataDir}:/app/data`, `safiyu/kontexta:${o.version}`, "mcp"] };
  }
  const env = !o.isDefaultDir || o.forceEnv ? { KONTEXTA_DATA_DIR: o.dataDir } : undefined;
  if (o.installMode === "npm") {
    const entry: ServerEntry = { command: o.absolute ? absoluteNpx(node) : "npx", args: o.hasLocalCliMcp ? ["-y", "kontexta", "mcp"] : ["-y", "kontexta-mcp"] };
    if (env) entry.env = env;
    return entry;
  }
  if (!o.sourceEntrypoint) throw new Error("source install needs the MCP entrypoint path");
  const entry: ServerEntry = { command: o.absolute ? node : "node", args: [o.sourceEntrypoint] };
  if (env) entry.env = env;
  return entry;
}

// Changes whenever the desired registration changes, so reconcile can tell an up-to-date install from a stale one.
export function entrySignature(entry: ServerEntry, approval: McpApproval, tools: readonly string[]): string {
  return createHash("sha1").update(JSON.stringify({ entry, approval, tools: approval === "prompt" ? [] : [...tools].sort() })).digest("hex").slice(0, 12);
}

// Whether an existing config entry already equals the desired one (an empty env counts as none; extra keys are ignored).
export function sameEntry(existing: unknown, entry: ServerEntry): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const e = existing as Record<string, unknown>;
  const env = (v: unknown) => (v && typeof v === "object" && Object.keys(v as object).length > 0 ? JSON.stringify(v) : "");
  return e.command === entry.command && JSON.stringify(e.args ?? []) === JSON.stringify(entry.args) && env(e.env) === env(entry.env);
}
