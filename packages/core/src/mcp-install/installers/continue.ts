import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeTextWithBackup } from "../write.js";
import { sameEntry, type ServerEntry } from "../entry.js";
import type { McpCtx, McpInstaller, McpResult, McpStatus } from "../types.js";
import { SERVER_KEY } from "./json-servers.js";

// We own this whole file, so there is no merge: it is written fresh and removed on uninstall.
const OWNER = "kontexta";
const dir = (ctx: McpCtx) => join(ctx.home, ".continue");
const file = (ctx: McpCtx) => join(dir(ctx), "mcpServers", "kontexta.yaml");

function read(path: string): { doc: Record<string, unknown> | null; ours: boolean } {
  if (!existsSync(path)) return { doc: null, ours: false };
  try {
    const doc = parse(readFileSync(path, "utf8"));
    return { doc, ours: !!doc && typeof doc === "object" && (doc as Record<string, unknown>).name === OWNER };
  } catch { return { doc: null, ours: false }; }
}

const serverOf = (doc: Record<string, unknown> | null): unknown => (Array.isArray(doc?.mcpServers) ? (doc!.mcpServers as Array<Record<string, unknown>>).find((s) => s?.name === SERVER_KEY) : undefined);

function render(entry: ServerEntry, version: string): string {
  const server: Record<string, unknown> = { name: SERVER_KEY, command: entry.command, args: entry.args };
  if (entry.env) server.env = entry.env;
  return stringify({ name: OWNER, version, schema: "v1", mcpServers: [server] }, { lineWidth: 0 });
}

export const continueMcpInstaller: McpInstaller = {
  id: "continue",
  entryHints: {},
  supportsApproval: false,
  configPath: file,
  install(ctx): McpResult {
    const path = file(ctx);
    if (!existsSync(dir(ctx))) throw new Error(`Continue config folder not found (${dir(ctx)}); open Continue once, or add the server by hand from the INSTALL tab`);
    const existing = read(path);
    if (existsSync(path) && !existing.ours) throw new Error(`${path} exists but was not created by kontexta; refusing to overwrite it`);
    if (!ctx.dryRun) mkdirSync(join(dir(ctx), "mcpServers"), { recursive: true });
    return { agent: "continue", path, changed: writeTextWithBackup(path, render(ctx.entry, ctx.version), ctx.dryRun), notes: ["MCP tools only appear in Continue's Agent Mode."] };
  },
  uninstall(ctx): McpResult {
    const path = file(ctx);
    const existing = read(path);
    if (!existing.ours) return { agent: "continue", path, changed: false, notes: [] };
    if (!ctx.dryRun) rmSync(path, { force: true });
    return { agent: "continue", path, changed: true, notes: [] };
  },
  status(ctx): McpStatus {
    const path = file(ctx);
    const { doc, ours } = read(path);
    const server = ours ? serverOf(doc) : undefined;
    return { agent: "continue", path, installed: server !== undefined, current: sameEntry(server, ctx.entry), notes: [] };
  },
};
