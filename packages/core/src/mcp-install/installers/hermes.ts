import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar } from "yaml";
import { writeTextWithBackup } from "../write.js";
import { sameEntry, toServerEntry } from "../entry.js";
import type { McpCtx, McpInstaller, McpResult, McpStatus } from "../types.js";
import { dumpYaml, loadYamlDoc, type YamlDoc } from "../yaml-config.js";
import { SERVER_KEY } from "./json-servers.js";

const dir = (ctx: McpCtx) => join(ctx.home, ".hermes");
const file = (ctx: McpCtx) => join(dir(ctx), "config.yaml");

function serversMap(doc: YamlDoc, path: string, create: boolean) {
  const existing = doc.get("mcp_servers", true);
  if (existing === undefined || (isScalar(existing) && existing.value === null)) {
    if (!create) return null;
    const created = doc.createNode({});
    doc.set("mcp_servers", created);
    return created as import("yaml").YAMLMap;
  }
  if (!isMap(existing)) throw new Error(`${path} has an "mcp_servers" key that is not a mapping; refusing to change it`);
  return existing;
}

export const hermesMcpInstaller: McpInstaller = {
  id: "hermes",
  // Hermes hands MCP servers only PATH/HOME/USER/… plus the entry's own env, so spell out the data dir and commands.
  entryHints: { forceEnv: true, absolute: true },
  supportsApproval: false,
  configPath: file,
  install(ctx): McpResult {
    const path = file(ctx);
    if (!existsSync(dir(ctx))) throw new Error(`Hermes config folder not found (${dir(ctx)}); run Hermes once, or add the server by hand from the INSTALL tab`);
    const doc = loadYamlDoc(path);
    const servers = serversMap(doc, path, true)!;
    const node: Record<string, unknown> = { command: ctx.entry.command, args: ctx.entry.args };
    if (ctx.entry.env) node.env = ctx.entry.env;
    if (!sameEntry((servers.toJSON() as Record<string, unknown>)[SERVER_KEY], ctx.entry)) {
      const existing = servers.get(SERVER_KEY, true);
      if (!isMap(existing)) servers.set(SERVER_KEY, doc.createNode(node));
      else {
        // Update in place so keys the user added (timeout, other env) survive; only command, args and KONTEXTA_DATA_DIR are ours.
        existing.set("command", ctx.entry.command);
        existing.set("args", doc.createNode(ctx.entry.args));
        const envNode = existing.get("env", true);
        if (ctx.entry.env) {
          if (isMap(envNode)) envNode.set("KONTEXTA_DATA_DIR", ctx.entry.env.KONTEXTA_DATA_DIR);
          else existing.set("env", doc.createNode(ctx.entry.env));
        } else if (isMap(envNode)) {
          envNode.delete("KONTEXTA_DATA_DIR");
          if (envNode.items.length === 0) existing.delete("env");
        }
      }
    }
    return { agent: "hermes", path, changed: writeTextWithBackup(path, dumpYaml(doc), ctx.dryRun), notes: ["Restart Hermes: MCP servers are loaded at startup only. Only the default profile is configured."] };
  },
  uninstall(ctx): McpResult {
    const path = file(ctx);
    if (!existsSync(path)) return { agent: "hermes", path, changed: false, notes: [] };
    const doc = loadYamlDoc(path);
    const servers = serversMap(doc, path, false);
    if (!servers || !servers.has(SERVER_KEY)) return { agent: "hermes", path, changed: false, notes: [] };
    servers.delete(SERVER_KEY);
    if (servers.items.length === 0) doc.delete("mcp_servers");
    return { agent: "hermes", path, changed: writeTextWithBackup(path, dumpYaml(doc), ctx.dryRun), notes: [] };
  },
  status(ctx): McpStatus {
    const path = file(ctx);
    const notes: string[] = [];
    try {
      const doc = loadYamlDoc(path);
      const servers = serversMap(doc, path, false);
      const existing = servers ? (servers.toJSON() as Record<string, unknown>)[SERVER_KEY] : undefined;
      return { agent: "hermes", path, installed: existing !== undefined, current: sameEntry(existing, ctx.entry), entry: toServerEntry(existing), notes };
    } catch (e) {
      notes.push((e as Error).message);
      return { agent: "hermes", path, installed: false, current: false, notes };
    }
  },
};
