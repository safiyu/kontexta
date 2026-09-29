import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { syncAgentRows, setEnabled, listAgents } from "../../src/hooks/registry.js";
import { EMITTER_VERSION, stagedEmitterPath } from "../../src/hooks/stage.js";
import { installHooks, uninstallHooks, hooksStatus, reconcile } from "../../src/hooks/install.js";

let home: string; let dataDir: string;
const opts = () => ({ home, dataDir });
const row = (id: string) => listAgents().find((r) => r.id === id)!;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kontexta-home-")); dataDir = mkdtempSync(join(tmpdir(), "kontexta-data-"));
  createDatabase(join(dataDir, "kontexta.db")); syncAgentRows();
});
afterEach(() => { closeDatabase(); rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });

describe("installHooks", () => {
  it("stages the emitter and sidecar, installs, and marks the DB", () => {
    getDatabase().prepare(`INSERT INTO projects (name, slug, path) VALUES ('Demo', 'demo', '/tmp/demo')`).run();
    const out = installHooks(["claude-code", "cursor"], opts());
    expect(out.map((o) => [o.agent, o.ok, o.changed])).toEqual([["claude-code", true, true], ["cursor", true, true]]);
    expect(existsSync(stagedEmitterPath(dataDir))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "hooks", "projects.json"), "utf8")).projects).toEqual([{ slug: "demo", path: "/tmp/demo" }]);
    expect(row("claude-code")).toMatchObject({ hooks_installed: true, hooks_version: EMITTER_VERSION });
    expect(row("cursor").hooks_installed).toBe(true);
  });

  it("isolates a failing installer and does not mark it", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ broken");
    const out = installHooks(["claude-code", "gemini"], opts());
    expect(out[0]).toMatchObject({ agent: "claude-code", ok: false });
    expect(out[0].error).toMatch(/not valid JSON/);
    expect(out[1]).toMatchObject({ agent: "gemini", ok: true });
    expect(row("claude-code").hooks_installed).toBe(false);
    expect(row("gemini").hooks_installed).toBe(true);
  });

  it("rejects unsupported and unknown ids without touching the DB", () => {
    const out = installHooks(["aider", "nope"], opts());
    expect(out.map((o) => o.ok)).toEqual([false, false]);
    expect(out[0].error).toMatch(/does not support hooks/);
    expect(out[1].error).toMatch(/unknown agent/);
  });

  it("dry-run writes nothing and marks nothing", () => {
    const out = installHooks(["gemini"], { ...opts(), dryRun: true });
    expect(out[0]).toMatchObject({ ok: true, changed: true });
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(false);
    expect(existsSync(stagedEmitterPath(dataDir))).toBe(false);
    expect(row("gemini").hooks_installed).toBe(false);
  });
});

describe("uninstallHooks", () => {
  it("removes owned entries and clears the DB mark", () => {
    installHooks(["codex"], opts());
    const out = uninstallHooks(["codex"], opts());
    expect(out[0]).toMatchObject({ ok: true, changed: true });
    expect(row("codex")).toMatchObject({ hooks_installed: false, hooks_version: null });
    expect(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"))).toEqual({});
  });
});

describe("uninstall is not undone by reconcile", () => {
  it("an explicitly uninstalled agent stays uninstalled and disabled after reconcile", () => {
    setEnabled("gemini", true); installHooks(["gemini"], opts());
    uninstallHooks(["gemini"], opts());
    expect(row("gemini")).toMatchObject({ enabled: false, hooks_installed: false });
    expect(reconcile(opts())).toEqual([]);
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).not.toContain("emit.mjs");
  });
});

describe("hooksStatus", () => {
  it("merges DB rows with live config presence and emitter staleness", () => {
    installHooks(["claude-code"], opts());
    writeFileSync(stagedEmitterPath(dataDir), "// kontexta-hooks v0.0.1\n");
    const s = hooksStatus(opts());
    expect(s).toHaveLength(15);
    const cc = s.find((r) => r.id === "claude-code")!;
    expect(cc).toMatchObject({ hooks_installed: true, config_present: true, emitter_version_on_disk: "0.0.1", emitter_stale: true });
    expect(cc.config_path).toBe(join(home, ".claude", "settings.json"));
    const aider = s.find((r) => r.id === "aider")!;
    expect(aider).toMatchObject({ hooks_supported: false, config_path: null, config_present: false });
  });
});

describe("reconcile", () => {
  it("installs enabled+supported agents that are missing or stale, never disabled ones", () => {
    setEnabled("claude-code", true);
    setEnabled("gemini", true); installHooks(["gemini"], opts());
    setEnabled("codex", true); installHooks(["codex"], opts());
    getDatabase().prepare("UPDATE agents SET hooks_version = '0.0.1' WHERE id = 'codex'").run();
    setEnabled("aider", true);
    const out = reconcile(opts());
    expect(out.map((o) => o.agent).sort()).toEqual(["claude-code", "codex"]);
    expect(out.every((o) => o.ok)).toBe(true);
    expect(row("claude-code").hooks_installed).toBe(true);
    expect(row("codex").hooks_version).toBe(EMITTER_VERSION);
    expect(existsSync(join(home, ".cursor", "hooks.json"))).toBe(false);
    expect(reconcile(opts())).toEqual([]);
  });

  it("re-stages a stale emitter even when every agent is up to date", () => {
    setEnabled("gemini", true); installHooks(["gemini"], opts());
    writeFileSync(stagedEmitterPath(dataDir), "// kontexta-hooks v0.0.1\n");
    const out = reconcile(opts());
    expect(out.map((o) => o.agent)).toEqual(["gemini"]);
    expect(readFileSync(stagedEmitterPath(dataDir), "utf8").split(/\r?\n/)[0]).toBe(`// kontexta-hooks v${EMITTER_VERSION}`);
  });
});
