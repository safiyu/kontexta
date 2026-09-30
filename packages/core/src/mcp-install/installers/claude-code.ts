import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonConfig } from "../../hooks/installers/json-config.js";
import { writeJsonWithBackup } from "../write.js";
import { sameEntry, type ServerEntry } from "../entry.js";
import type { McpCtx, McpInstaller, McpResult, McpStatus, Runner } from "../types.js";
import { applyConfigApproval, SERVER_KEY, type ConfigApprovalSpec } from "./json-servers.js";

const defaultRun: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

// Claude Code names tools mcp__<server>__<tool> with punctuation turned into underscores.
const APPROVAL: ConfigApprovalSpec = {
  isOurs: (r) => /^mcp__kxta(__|$)/.test(r),
  rule: (tool) => `mcp__${SERVER_KEY}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`,
  wildcard: `mcp__${SERVER_KEY}`,
};

const dotClaude = (ctx: McpCtx) => join(ctx.home, ".claude.json");
const settingsPath = (ctx: McpCtx) => join(ctx.home, ".claude", "settings.json");
const addArgs = (entry: ServerEntry): string[] => ["mcp", "add", SERVER_KEY, "-s", "user", ...Object.entries(entry.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--", entry.command, ...entry.args];
const shellQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
const manual = (entry: ServerEntry) => ["claude", ...addArgs(entry)].map(shellQuote).join(" ");

// Read-only peek at the user-scope entry; the claude CLI stays the only writer of ~/.claude.json.
function currentEntry(ctx: McpCtx): unknown {
  const p = dotClaude(ctx);
  if (!existsSync(p)) return undefined;
  try {
    const servers = JSON.parse(readFileSync(p, "utf8"))?.mcpServers;
    return servers && typeof servers === "object" ? servers[SERVER_KEY] : undefined;
  } catch { return undefined; }
}

function applyRules(ctx: McpCtx, approval: McpCtx["approval"], previous: McpCtx["approval"]): boolean {
  const path = settingsPath(ctx);
  if (approval === "prompt" && previous === "prompt") return false;
  if (!existsSync(path) && approval === "prompt") return false;
  const cfg = readJsonConfig(path);
  const next = applyConfigApproval(cfg, APPROVAL, { ...ctx, approval, previousApproval: previous }, path);
  return next === cfg ? false : writeJsonWithBackup(path, next, ctx.dryRun);
}

export const claudeCodeMcpInstaller: McpInstaller = {
  id: "claude-code",
  entryHints: {},
  supportsApproval: true,
  configPath: dotClaude,
  install(ctx): McpResult {
    const run = ctx.run ?? defaultRun;
    const path = dotClaude(ctx);
    const current = sameEntry(currentEntry(ctx), ctx.entry);
    let changed = false;
    if (!current) {
      changed = true;
      if (!ctx.dryRun) {
        const probe = run("claude", ["--version"]);
        if (probe.error || probe.status !== 0) throw new Error(`claude CLI not found on PATH; run this yourself:\n  ${manual(ctx.entry)}`);
        if (currentEntry(ctx) !== undefined) run("claude", ["mcp", "remove", SERVER_KEY, "-s", "user"]);
        const r = run("claude", addArgs(ctx.entry));
        if (r.error || r.status !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.error?.message || "unknown error").trim()}`);
        if (!sameEntry(currentEntry(ctx), ctx.entry)) throw new Error("claude mcp add ran but ~/.claude.json does not show the kxta server; check `claude mcp list`");
      }
    }
    if (applyRules(ctx, ctx.approval, ctx.previousApproval)) changed = true;
    return { agent: "claude-code", path, changed, notes: ["Restart Claude Code sessions to pick up the kxta server."] };
  },
  uninstall(ctx): McpResult {
    const run = ctx.run ?? defaultRun;
    let changed = false;
    if (currentEntry(ctx) !== undefined) {
      changed = true;
      if (!ctx.dryRun) {
        const probe = run("claude", ["--version"]);
        if (probe.error || probe.status !== 0) throw new Error(`claude CLI not found on PATH; run this yourself:\n  claude mcp remove ${SERVER_KEY} -s user`);
        const r = run("claude", ["mcp", "remove", SERVER_KEY, "-s", "user"]);
        if (r.error || r.status !== 0) throw new Error(`claude mcp remove failed: ${(r.stderr || r.error?.message || "unknown error").trim()}`);
      }
    }
    if (applyRules(ctx, "prompt", "all")) changed = true;
    return { agent: "claude-code", path: dotClaude(ctx), changed, notes: [] };
  },
  status(ctx): McpStatus {
    const existing = currentEntry(ctx);
    return { agent: "claude-code", path: dotClaude(ctx), installed: existing !== undefined, current: sameEntry(existing, ctx.entry), notes: [] };
  },
};
