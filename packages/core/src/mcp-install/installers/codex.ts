import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { sameEntry, toServerEntry, type ServerEntry } from "../entry.js";
import type { McpCtx, McpInstaller, McpResult, McpStatus, Runner } from "../types.js";
import { SERVER_KEY } from "./json-servers.js";

const defaultRun: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

// Codex keeps MCP servers in config.toml ([mcp_servers.<name>]); `codex mcp add` is the only writer so the TOML is never edited here.
const configToml = (ctx: McpCtx) => join((ctx.env ?? process.env).CODEX_HOME || join(ctx.home, ".codex"), "config.toml");
const addArgs = (entry: ServerEntry): string[] => ["mcp", "add", SERVER_KEY, ...Object.entries(entry.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", entry.command, ...entry.args];
const shellQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
const manual = (entry: ServerEntry) => ["codex", ...addArgs(entry)].map(shellQuote).join(" ");

function currentEntry(ctx: McpCtx): unknown {
  const p = configToml(ctx);
  if (!existsSync(p)) return undefined;
  try {
    const servers = (parse(readFileSync(p, "utf8")) as Record<string, unknown>).mcp_servers;
    return servers && typeof servers === "object" ? (servers as Record<string, unknown>)[SERVER_KEY] : undefined;
  } catch { return undefined; }
}

const missing = (what: string) => new Error(`codex CLI not found on PATH; run this yourself:\n  ${what}`);

export const codexMcpInstaller: McpInstaller = {
  id: "codex",
  entryHints: {},
  supportsApproval: false,
  configPath: configToml,
  install(ctx): McpResult {
    const run = ctx.run ?? defaultRun;
    const path = configToml(ctx);
    const current = sameEntry(currentEntry(ctx), ctx.entry);
    let changed = false;
    if (!current) {
      changed = true;
      if (!ctx.dryRun) {
        const probe = run("codex", ["--version"]);
        if (probe.error || probe.status !== 0) throw missing(manual(ctx.entry));
        if (currentEntry(ctx) !== undefined) run("codex", ["mcp", "remove", SERVER_KEY]);
        const r = run("codex", addArgs(ctx.entry));
        if (r.error || r.status !== 0) throw new Error(`codex mcp add failed: ${(r.stderr || r.error?.message || "unknown error").trim()}`);
        if (!sameEntry(currentEntry(ctx), ctx.entry)) throw new Error("codex mcp add ran but config.toml does not show the kxta server; check `codex mcp list`");
      }
    }
    return { agent: "codex", path, changed, notes: ["Restart Codex to pick up the kxta server."] };
  },
  uninstall(ctx): McpResult {
    const run = ctx.run ?? defaultRun;
    const path = configToml(ctx);
    if (currentEntry(ctx) === undefined) return { agent: "codex", path, changed: false, notes: [] };
    if (!ctx.dryRun) {
      const probe = run("codex", ["--version"]);
      if (probe.error || probe.status !== 0) throw missing(`codex mcp remove ${SERVER_KEY}`);
      const r = run("codex", ["mcp", "remove", SERVER_KEY]);
      if (r.error || r.status !== 0) throw new Error(`codex mcp remove failed: ${(r.stderr || r.error?.message || "unknown error").trim()}`);
    }
    return { agent: "codex", path, changed: true, notes: [] };
  },
  status(ctx): McpStatus {
    const existing = currentEntry(ctx);
    return { agent: "codex", path: configToml(ctx), installed: existing !== undefined, current: sameEntry(existing, ctx.entry), entry: toServerEntry(existing), notes: [] };
  },
};
