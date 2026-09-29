#!/usr/bin/env node
// Hooks CLI shipped inside the MCP bundle so `kontexta hooks …` and the Docker image reach kxta-core without a second dependency graph.
import { parseArgs } from "node:util";
import {
  getDataDir, ensureDataDir, resetDataDirCache, getDatabase, closeDatabase,
  syncAgentRows, setEnabled, listAgents, isAgentId,
  installHooks, uninstallHooks, hooksStatus, reconcile, stageEmitter, syncProjectsSidecar,
  type AgentHookOutcome,
} from "kxta-core";

const USAGE = `kontexta hooks — install coding-agent hooks that feed the journal

Usage:
  kontexta hooks status [--json]
  kontexta hooks install (--agent a,b | --all-enabled) [--dry-run] [--json]
  kontexta hooks uninstall --agent a,b [--dry-run] [--json]
  kontexta hooks enable <agent> [--no-install] [--json]
  kontexta hooks disable <agent>
  kontexta hooks reconcile [--json]
  kontexta hooks stage

Common flags: --home <dir> --data-dir <dir> --project-dir <dir> --node <cmd>
Docker host installs: --host-data-dir <dir> (path baked into agent configs) and --no-db (install/uninstall only; never opens the database)
`;

function print(s: string) { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); }

function report(outcomes: AgentHookOutcome[], json: boolean): number {
  if (json) { print(JSON.stringify(outcomes, null, 2)); return outcomes.every((o) => o.ok) ? 0 : 1; }
  for (const o of outcomes) {
    if (!o.ok) print(`${o.agent}: FAILED — ${o.error}`);
    else print(`${o.agent}: ${o.changed ? "installed" : "already up to date"}${o.path ? ` (${o.path})` : ""}`);
    for (const n of o.notes) print(`  note: ${n}`);
  }
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

export async function runHooksCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      json: { type: "boolean", default: false }, agent: { type: "string" }, "all-enabled": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false }, home: { type: "string" }, "data-dir": { type: "string" },
      "project-dir": { type: "string" }, node: { type: "string" }, "no-install": { type: "boolean", default: false },
      "host-data-dir": { type: "string" }, "no-db": { type: "boolean", default: false },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || !["status", "install", "uninstall", "enable", "disable", "reconcile", "stage"].includes(cmd)) { process.stderr.write(USAGE); return 2; }

  const noDb = values["no-db"];
  if (noDb && cmd !== "install" && cmd !== "uninstall") { process.stderr.write("--no-db only supports install and uninstall\n"); return 2; }
  if (noDb && values["all-enabled"]) { process.stderr.write("--all-enabled needs the database; pass --agent instead\n"); return 2; }

  if (values["data-dir"]) { process.env.KONTEXTA_DATA_DIR = values["data-dir"]; resetDataDirCache(); }
  ensureDataDir();
  const dataDir = getDataDir();
  if (!noDb) { getDatabase(); syncAgentRows(); }
  const opts = { home: values.home, dataDir, hostDataDir: values["host-data-dir"], nodeCmd: values.node, projectDir: values["project-dir"], dryRun: values["dry-run"], registry: !noDb };

  try {
    switch (cmd) {
      case "status": {
        const rows = hooksStatus(opts);
        if (values.json) { print(JSON.stringify(rows, null, 2)); return 0; }
        for (const r of rows) {
          const state = !r.hooks_supported ? "MCP capture only" : r.hooks_installed ? `installed v${r.hooks_version}${r.emitter_stale ? " (emitter stale)" : ""}${r.hooks_verified_at ? ", verified" : ", not yet verified"}` : "not installed";
          print(`${r.enabled ? "[x]" : "[ ]"} ${r.id.padEnd(14)} ${state}${r.config_path ? `  ${r.config_path}` : ""}`);
        }
        return 0;
      }
      case "install": {
        const ids = values["all-enabled"] ? listAgents().filter((r) => r.enabled && r.hooks_supported).map((r) => r.id) : (values.agent ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0) { process.stderr.write("install: pass --agent a,b or --all-enabled\n"); return 2; }
        return report(installHooks(ids, opts), values.json);
      }
      case "uninstall": {
        const ids = (values.agent ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0) { process.stderr.write("uninstall: pass --agent a,b\n"); return 2; }
        return report(uninstallHooks(ids, opts), values.json);
      }
      case "enable": {
        if (!arg || !isAgentId(arg)) { process.stderr.write(`enable: unknown agent '${arg ?? ""}'\n`); return 2; }
        setEnabled(arg, true);
        print(`${arg}: enabled`);
        if (values["no-install"]) return 0;
        const supported = listAgents().find((r) => r.id === arg)!.hooks_supported;
        if (!supported) { print(`${arg}: MCP capture only (no hook API)`); return 0; }
        return report(installHooks([arg], opts), values.json);
      }
      case "disable": {
        if (!arg || !isAgentId(arg)) { process.stderr.write(`disable: unknown agent '${arg ?? ""}'\n`); return 2; }
        setEnabled(arg, false);
        print(`${arg}: disabled (hook config left in place; run 'kontexta hooks uninstall --agent ${arg}' to remove it)`);
        return 0;
      }
      case "reconcile": return report(reconcile(opts), values.json);
      case "stage": {
        const s = stageEmitter(dataDir); const p = syncProjectsSidecar(dataDir);
        print(`emitter v${s.version} ${s.changed ? "staged" : "up to date"} at ${s.path}; ${p.count} project(s) in ${p.path}`);
        return 0;
      }
    }
    return 2;
  } finally {
    if (!noDb) closeDatabase();
  }
}

runHooksCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 1; });
