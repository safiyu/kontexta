import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { syncAgentRows, listAgents } from "../../src/hooks/registry.js";
import { installHooks } from "../../src/hooks/install.js";

let home: string; let dataDir: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kx-h-")); dataDir = mkdtempSync(join(tmpdir(), "kx-d-")); });
afterEach(() => { closeDatabase(); rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });

describe("host-side install (docker path)", () => {
  it("writes HOST paths into the agent config but stages the emitter in the container data dir, without touching the DB", () => {
    const out = installHooks(["gemini", "opencode"], { home, dataDir, hostDataDir: "/host/kx-data", registry: false });
    expect(out.map((o) => o.ok)).toEqual([true, true]);
    expect(existsSync(join(dataDir, "hooks", "emit.mjs"))).toBe(true);
    expect(existsSync(join(dataDir, "hooks", "projects.json"))).toBe(false);
    const cfg = readFileSync(join(home, ".gemini", "settings.json"), "utf8");
    expect(cfg).toContain("/host/kx-data/hooks/emit.mjs");
    expect(cfg).toContain('--data-dir \\"/host/kx-data\\"');
    expect(cfg).not.toContain(dataDir);
    const plugin = readFileSync(join(home, ".config", "opencode", "plugins", "kontexta.ts"), "utf8");
    expect(plugin).toContain('"/host/kx-data/hooks/emit.mjs"');
    expect(plugin).toContain('const DATA_DIR = "/host/kx-data"');
  });

  it("registry:true (default) still marks the DB and defaults host path to dataDir", () => {
    createDatabase(join(dataDir, "k.db")); syncAgentRows();
    installHooks(["gemini"], { home, dataDir });
    expect(listAgents().find((r) => r.id === "gemini")!.hooks_installed).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    expect(cfg.hooks.BeforeAgent[0].hooks[0].command).toContain(join(dataDir, "hooks", "emit.mjs"));
  });
});
