import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { syncAgentRows, listAgents, setEnabled } from "../../src/hooks/registry.js";
import { installMcp, uninstallMcp, mcpStatus, reconcileMcp } from "../../src/mcp-install/install.js";
import { KXTA_TOOLS } from "../../src/mcp-install/tools.generated.js";

describe("MCP orchestrator", () => {
  let home: string; let dataDir: string; let dbDir: string;
  const base = () => ({ home, dataDir, installMode: "npm" as const, version: "5.1.0" });
  const row = (id: string) => listAgents().find((r) => r.id === id)!;
  const cursorCfg = () => join(home, ".cursor", "mcp.json");
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kontexta-home-")); dataDir = mkdtempSync(join(tmpdir(), "kontexta-data-")); dbDir = mkdtempSync(join(tmpdir(), "kontexta-db-"));
    createDatabase(join(dbDir, "t.db")); syncAgentRows();
    mkdirSync(join(home, ".cursor")); mkdirSync(join(home, ".gemini")); mkdirSync(join(home, ".cline"));
  });
  afterEach(() => { closeDatabase(); for (const d of [home, dataDir, dbDir]) rmSync(d, { recursive: true, force: true }); });

  it("installs, records the signature and approval in the registry", () => {
    const [o] = installMcp(["cursor"], { ...base() });
    expect(o).toMatchObject({ agent: "cursor", ok: true, changed: true, approval: "prompt" });
    expect(JSON.parse(readFileSync(cursorCfg(), "utf8")).mcpServers.kxta.args).toEqual(["-y", "kontexta-mcp"]);
    expect(row("cursor")).toMatchObject({ mcp_installed: true, mcp_approval: "prompt" });
    expect(row("cursor").mcp_version).toBeTruthy();
  });

  it("rejects unknown or non-installable agents without touching anything", () => {
    const out = installMcp(["nope", "aider"], { ...base() });
    expect(out.map((o) => o.ok)).toEqual([false, false]);
    expect(out[0].error).toMatch(/unknown agent/);
    expect(out[1].error).toMatch(/not supported yet/i);
  });

  it("applies approval where the agent supports it and says so where it does not", () => {
    const out = installMcp(["gemini", "cursor"], { ...base(), approval: "all" });
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).permissions.allow).toEqual(["mcp(kxta/*)"]);
    expect(out[0]).toMatchObject({ approval: "all" });
    expect(out[1]).toMatchObject({ approval: "prompt" });
    expect(out[1].notes.join(" ")).toMatch(/no config-file allowlist/i);
    expect(row("gemini").mcp_approval).toBe("all");
    expect(row("cursor").mcp_approval).toBe("prompt");
  });

  it("switching from all back to prompt removes the rules it added", () => {
    installMcp(["gemini"], { ...base(), approval: "all" });
    installMcp(["gemini"], { ...base(), approval: "prompt" });
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).permissions).toBeUndefined();
  });

  it("safe excludes destructive tools", () => {
    installMcp(["cline"], { ...base(), approval: "safe" });
    const allow: string[] = JSON.parse(readFileSync(join(home, ".cline", "mcp_settings.json"), "utf8")).mcpServers.kxta.alwaysAllow;
    expect(allow).toContain("files.read");
    expect(allow).not.toContain("files.delete");
    expect(allow.length).toBe(KXTA_TOOLS.filter((t) => !t.destructive).length);
  });

  it("a failing installer reports its error and leaves the registry untouched", () => {
    const [o] = installMcp(["continue"], { ...base() });
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/not found/i);
    expect(row("continue").mcp_installed).toBe(false);
  });

  it("dry-run changes nothing on disk or in the registry", () => {
    installMcp(["cursor"], { ...base(), dryRun: true });
    expect(existsSync(cursorCfg())).toBe(false);
    expect(row("cursor").mcp_installed).toBe(false);
  });

  it("uninstall removes the entry and resets the registry but keeps the agent enabled", () => {
    setEnabled("cursor", true);
    installMcp(["cursor"], { ...base() });
    const [o] = uninstallMcp(["cursor"], { ...base() });
    expect(o).toMatchObject({ ok: true, changed: true });
    expect(row("cursor")).toMatchObject({ mcp_installed: false, enabled: true });
  });

  it("status reports presence, currency and stale signatures", () => {
    installMcp(["cursor"], { ...base() });
    let s = mcpStatus({ ...base() }).find((r) => r.id === "cursor")!;
    expect(s).toMatchObject({ mcp_supported: true, installed: true, current: true, stale: false });
    s = mcpStatus({ ...base(), installMode: "source", sourceEntrypoint: "/x/index.js" }).find((r) => r.id === "cursor")!;
    expect(s).toMatchObject({ current: false, stale: true });
    expect(mcpStatus({ ...base() }).find((r) => r.id === "aider")!.mcp_supported).toBe(false);
    const support = Object.fromEntries(mcpStatus({ ...base() }).map((r) => [r.id, r.approval_supported]));
    expect(support).toMatchObject({ "claude-code": true, gemini: true, cline: true, cursor: false, hermes: false, continue: false, codex: false, copilot: false });
  });

  it("docker mode needs the host dir; with it the entry mounts it", () => {
    const [bad] = installMcp(["cursor"], { ...base(), installMode: "docker", registry: false });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/host data/i);
    const [ok] = installMcp(["cursor"], { ...base(), installMode: "docker", hostDataDir: "/home/me/kx", registry: false });
    expect(ok.ok).toBe(true);
    expect(JSON.parse(readFileSync(cursorCfg(), "utf8")).mcpServers.kxta.args).toContain("/home/me/kx:/app/data");
  });

  it("reconcile never makes a first-time registration, only refreshes ones we installed, and skips docker", () => {
    setEnabled("cursor", true); setEnabled("gemini", true);
    expect(reconcileMcp({ ...base() })).toEqual([]);
    expect(existsSync(cursorCfg())).toBe(false);
    installMcp(["cursor", "gemini"], { ...base() });
    expect(reconcileMcp({ ...base() })).toEqual([]);
    expect(reconcileMcp({ ...base(), installMode: "source", sourceEntrypoint: "/x/index.js" }).map((o) => o.agent).sort()).toEqual(["cursor", "gemini"]);
    expect(reconcileMcp({ ...base(), installMode: "docker", hostDataDir: "/h" })).toEqual([]);
  });

  it("reconcile leaves a hand-written entry alone until the user runs install", () => {
    setEnabled("cursor", true);
    writeFileSync(cursorCfg(), JSON.stringify({ mcpServers: { kxta: { command: "my-own", args: [] } } }));
    expect(reconcileMcp({ ...base() })).toEqual([]);
    expect(JSON.parse(readFileSync(cursorCfg(), "utf8")).mcpServers.kxta.command).toBe("my-own");
  });

  it("reconcile keeps each agent's stored approval level", () => {
    setEnabled("gemini", true);
    installMcp(["gemini"], { ...base(), approval: "all" });
    reconcileMcp({ ...base(), installMode: "source", sourceEntrypoint: "/x/index.js" });
    expect(row("gemini").mcp_approval).toBe("all");
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).permissions.allow).toEqual(["mcp(kxta/*)"]);
  });
});
