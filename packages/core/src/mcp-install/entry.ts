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

// We manage the command, args and KONTEXTA_DATA_DIR only; other env keys and fields belong to the user.
const dataDirOf = (env: unknown): string => (env && typeof env === "object" && typeof (env as Record<string, unknown>).KONTEXTA_DATA_DIR === "string" ? ((env as Record<string, string>).KONTEXTA_DATA_DIR) : "");

export function entryHashOf(entry: ServerEntry): string {
  return createHash("sha1").update(JSON.stringify({ c: entry.command, a: entry.args, d: dataDirOf(entry.env) })).digest("hex").slice(0, 8);
}

// "<entry hash>.<approval+tools hash>": reconcile can tell a user-edited entry (entry part differs from disk) from a stale one (policy or desired entry changed).
export function entrySignature(entry: ServerEntry, approval: McpApproval, tools: readonly string[]): string {
  const policy = createHash("sha1").update(JSON.stringify({ approval, tools: approval === "prompt" ? [] : [...tools].sort() })).digest("hex").slice(0, 8);
  return `${entryHashOf(entry)}.${policy}`;
}

export const entryHashOfSignature = (signature: string): string => signature.split(".")[0];

// Normalises whatever a config file holds into a ServerEntry (extra keys dropped), or undefined when it is not an entry.
export function toServerEntry(existing: unknown): ServerEntry | undefined {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return undefined;
  const e = existing as Record<string, unknown>;
  if (typeof e.command !== "string") return undefined;
  const dir = dataDirOf(e.env);
  return { command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [], ...(dir ? { env: { KONTEXTA_DATA_DIR: dir } } : {}) };
}

// Whether an existing config entry already equals the desired one (user-added env keys and extra fields are ignored).
export function sameEntry(existing: unknown, entry: ServerEntry): boolean {
  const e = toServerEntry(existing);
  return !!e && entryHashOf(e) === entryHashOf(entry);
}
