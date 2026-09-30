#!/usr/bin/env node
// `kontexta connect …`: registers the kxta MCP server in each agent's own config. Ships in the MCP bundle next to hooks-cli.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  getDataDir, ensureDataDir, resetDataDirCache, getDatabase, closeDatabase, syncAgentRows, listAgents, isAgentId, detectInstallMode,
  installMcp, uninstallMcp, mcpStatus, reconcileMcp, MCP_APPROVALS,
  type McpOutcome, type McpApproval, type InstallMode,
} from "kxta-core";

const USAGE = `kontexta connect: register the kxta MCP server in your coding agents

Usage:
  kontexta connect status [--json]
  kontexta connect install (--agent a,b | --all-enabled) [--approval prompt|safe|all] [--dry-run] [--json]
  kontexta connect uninstall --agent a,b [--dry-run] [--json]
  kontexta connect approval <agent> <prompt|safe|all>
  kontexta connect reconcile [--json]

Approval levels (which kxta tools the agent may call without asking): prompt = no change (default),
safe = everything except delete/restore/backup tools, all = every tool. Agents without a config-file allowlist keep asking.

Common flags: --home <dir> --data-dir <dir> --node <cmd> --install-mode docker|npm|source --source-entrypoint <file>
Docker host installs: --host-data-dir <dir> (the folder mounted at /app/data) and --no-db (never opens the database)
`;

function print(s: string) { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); }

function mcpPackageVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
      const p = join(dir, "package.json");
      if (existsSync(p)) { const pkg = JSON.parse(readFileSync(p, "utf8")); if (pkg.name === "kontexta-mcp" && pkg.version) return pkg.version; }
      dir = dirname(dir);
    }
  } catch { /* fall through */ }
  return "latest";
}

function report(outcomes: McpOutcome[], json: boolean): number {
  if (json) { print(JSON.stringify(outcomes, null, 2)); return outcomes.every((o) => o.ok) ? 0 : 1; }
  for (const o of outcomes) {
    if (!o.ok) print(`${o.agent}: FAILED, ${o.error}`);
    else print(`${o.agent}: ${o.changed ? "connected" : "already up to date"}${o.approval !== "prompt" ? ` (approval: ${o.approval})` : ""}${o.path ? `  ${o.path}` : ""}`);
    for (const n of o.notes) print(`  note: ${n}`);
  }
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

const ids = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export async function runConnectCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      json: { type: "boolean", default: false }, agent: { type: "string" }, "all-enabled": { type: "boolean", default: false },
      approval: { type: "string" }, "dry-run": { type: "boolean", default: false }, home: { type: "string" }, "data-dir": { type: "string" },
      node: { type: "string" }, "install-mode": { type: "string" }, "source-entrypoint": { type: "string" },
      "host-data-dir": { type: "string" }, "no-db": { type: "boolean", default: false },
    },
  });
  const [cmd, a1, a2] = positionals;
  if (!cmd || !["status", "install", "uninstall", "approval", "reconcile"].includes(cmd)) { process.stderr.write(USAGE); return 2; }

  const noDb = values["no-db"];
  if (noDb && cmd !== "install" && cmd !== "uninstall") { process.stderr.write("--no-db only supports install and uninstall\n"); return 2; }
  if (noDb && values["all-enabled"]) { process.stderr.write("--all-enabled needs the database; pass --agent instead\n"); return 2; }
  const level = (cmd === "approval" ? a2 : values.approval) as McpApproval | undefined;
  if (level !== undefined && !MCP_APPROVALS.includes(level)) { process.stderr.write(`approval must be one of ${MCP_APPROVALS.join(", ")}\n`); return 2; }
  const modeFlag = values["install-mode"];
  if (modeFlag !== undefined && !["docker", "npm", "source"].includes(modeFlag)) { process.stderr.write("--install-mode must be docker, npm or source\n"); return 2; }

  if (values["data-dir"]) { env.KONTEXTA_DATA_DIR = values["data-dir"]; process.env.KONTEXTA_DATA_DIR = values["data-dir"]; resetDataDirCache(); }
  ensureDataDir();
  const dataDir = getDataDir();
  if (!noDb) { getDatabase(); syncAgentRows(); }

  const installMode = (modeFlag as InstallMode | undefined) ?? detectInstallMode(env);
  const opts = {
    home: values.home, dataDir, hostDataDir: values["host-data-dir"] ?? env.KONTEXTA_HOST_DATA_DIR, installMode, version: mcpPackageVersion(),
    sourceEntrypoint: values["source-entrypoint"] ?? join(dirname(fileURLToPath(import.meta.url)), "index.js"),
    hasLocalCliMcp: installMode === "npm" && env.KONTEXTA_VIA_CLI === "1", nodeCmd: values.node, dryRun: values["dry-run"], registry: !noDb,
  };

  try {
    switch (cmd) {
      case "status": {
        const rows = mcpStatus(opts);
        if (values.json) { print(JSON.stringify(rows, null, 2)); return 0; }
        for (const r of rows.filter((x) => x.mcp_supported)) {
          const state = r.installed ? `${r.current ? "connected" : "connected (out of date)"}${r.mcp_approval !== "prompt" ? `, approval: ${r.mcp_approval}` : ""}` : "not connected";
          print(`${r.enabled ? "[x]" : "[ ]"} ${r.id.padEnd(14)} ${state}${r.config_path ? `  ${r.config_path}` : ""}`);
          for (const n of r.notes) print(`      ${n}`);
        }
        return 0;
      }
      case "install": {
        const list = values["all-enabled"] ? listAgents().filter((r) => r.enabled && r.mcp_supported).map((r) => r.id) : ids(values.agent);
        if (list.length === 0) { process.stderr.write("install: pass --agent a,b or --all-enabled\n"); return 2; }
        return report(installMcp(list, { ...opts, approval: level }), values.json);
      }
      case "uninstall": {
        const list = ids(values.agent);
        if (list.length === 0) { process.stderr.write("uninstall: pass --agent a,b\n"); return 2; }
        return report(uninstallMcp(list, opts), values.json);
      }
      case "approval": {
        if (!a1 || !isAgentId(a1) || !level) { process.stderr.write("approval: usage `kontexta connect approval <agent> <prompt|safe|all>`\n"); return 2; }
        return report(installMcp([a1], { ...opts, approval: level }), values.json);
      }
      case "reconcile": return report(reconcileMcp(opts), values.json);
    }
    return 2;
  } finally {
    if (!noDb) closeDatabase();
  }
}

runConnectCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 1; });
