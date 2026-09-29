import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { syncAgentRows, setEnabled, markInstalled } from "../../src/hooks/registry.js";
import { detectInstallMode } from "../../src/hooks/install-mode.js";
import { dockerInstallCommand, buildHooksBlock } from "../../src/hooks/alerts.js";

describe("detectInstallMode", () => {
  const no = () => false;
  it("prefers KONTEXTA_INSTALL_HINT", () => {
    expect(detectInstallMode({ KONTEXTA_INSTALL_HINT: "docker" }, no)).toBe("docker");
    expect(detectInstallMode({ KONTEXTA_INSTALL_HINT: "npm" }, () => true)).toBe("npm");
    expect(detectInstallMode({ KONTEXTA_INSTALL_HINT: "source" }, () => true)).toBe("source");
  });
  it("falls back to /.dockerenv, then npx, then source", () => {
    expect(detectInstallMode({}, (p) => p === "/.dockerenv")).toBe("docker");
    expect(detectInstallMode({ npm_execpath: "/usr/lib/node_modules/npm/bin/npx-cli.js" }, no)).toBe("npm");
    expect(detectInstallMode({}, no)).toBe("source");
  });
});

describe("dockerInstallCommand", () => {
  it("builds the host-side install one-liner with a placeholder when the host dir is unknown", () => {
    const c = dockerInstallCommand({ agent: "gemini", version: "5.0.0", hostDataDir: null });
    expect(c).toContain('-v "$HOME":/host');
    expect(c).toContain('-v "<DATA_DIR>":/app/data');
    expect(c).toContain("safiyu/kontexta:5.0.0 hooks install");
    expect(c).toContain("--home /host");
    expect(c).toContain('--host-data-dir "<DATA_DIR>"');
    expect(c).toContain("--no-db");
    expect(c.endsWith("--agent gemini")).toBe(true);
  });
  it("uses the real host dir when known", () => {
    expect(dockerInstallCommand({ agent: "cursor", version: "5.0.0", hostDataDir: "/srv/kx" })).toContain('-v "/srv/kx":/app/data');
  });

  it("treats a relative host dir (compose's ./kontexta-data default) as unknown, since it can't be resolved from inside the container", () => {
    for (const rel of ["./kontexta-data", "kontexta-data", "../data"]) {
      const c = dockerInstallCommand({ agent: "cursor", version: "5.0.0", hostDataDir: rel });
      expect(c).toContain('-v "<DATA_DIR>":/app/data');
      expect(c).not.toContain(rel);
    }
  });

  it("accepts absolute Windows host paths", () => {
    expect(dockerInstallCommand({ agent: "cursor", version: "5.0.0", hostDataDir: "C:\\Users\\me\\kx" })).toContain("C:");
  });

  it("escapes characters that would break or expand inside double quotes", () => {
    const c = dockerInstallCommand({ agent: "cursor", version: "5.0.0", hostDataDir: '/srv/we"ird $(x) `y`' });
    expect(c).toContain('-v "/srv/we\\"ird \\$(x) \\`y\\`":/app/data');
    expect(c).not.toContain('$(x) `y`":');
  });
});

describe("buildHooksBlock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kontexta-alerts-")); createDatabase(join(dir, "t.db")); syncAgentRows(); });
  afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

  it("has no alerts and no prompt when nothing is enabled", () => {
    expect(buildHooksBlock({ installMode: "npm", version: "5.0.0" })).toEqual({ install_mode: "npm", alerts: [], prompt: null });
  });

  it("never mentions disabled or unsupported agents", () => {
    setEnabled("aider", true);
    expect(buildHooksBlock({ installMode: "npm", version: "5.0.0" }).alerts).toEqual([]);
  });

  it("npm mode: alerts enabled-but-missing agents and tells the agent how to install", () => {
    setEnabled("claude-code", true);
    setEnabled("gemini", true); markInstalled("gemini", "x");
    const b = buildHooksBlock({ installMode: "npm", version: "5.0.0" });
    expect(b.alerts.map((a) => a.agent)).toEqual(["claude-code"]);
    expect(b.alerts[0]).toMatchObject({ name: "Claude Code", installed: false, verified_at: null });
    expect(b.alerts[0].docker_command).toBeUndefined();
    expect(b.prompt).toContain("Claude Code");
    expect(b.prompt).toContain("admin.onboard_agent");
    expect(b.prompt).toContain("hooks:true");
  });

  it("docker mode: attaches a docker_command to every alert and does not suggest onboard_agent", () => {
    setEnabled("codex", true);
    const b = buildHooksBlock({ installMode: "docker", version: "5.0.0", hostDataDir: "/srv/kx" });
    expect(b.alerts[0].docker_command).toContain("--agent codex");
    expect(b.prompt).toContain("docker");
    expect(b.prompt).not.toContain("admin.onboard_agent");
  });

  it("installed-but-silent agents get a distinct 'no events' message", () => {
    setEnabled("cursor", true); markInstalled("cursor", "x");
    getDatabase().prepare("UPDATE agents SET hooks_installed_at = '2026-09-01T00:00:00.000Z' WHERE id = 'cursor'").run();
    const b = buildHooksBlock({ installMode: "npm", version: "5.0.0", now: new Date("2026-09-29T00:00:00Z") });
    expect(b.alerts[0]).toMatchObject({ agent: "cursor", installed: true });
    expect(b.prompt).toMatch(/installed but no events/i);
    expect(b.prompt).toContain("kontexta hooks status");
  });

  it("only offers admin.onboard_agent for agents the tool accepts; the rest get the CLI command", () => {
    setEnabled("claude-code", true);
    setEnabled("windsurf", true);
    const b = buildHooksBlock({ installMode: "npm", version: "5.0.0" });
    const toolList = /one of \(([^)]*)\)/.exec(b.prompt ?? "")?.[1] ?? "";
    expect(toolList).toContain("claude-code");
    expect(toolList).not.toContain("windsurf");
    expect(b.prompt).toContain("kontexta hooks install --agent windsurf");
  });

  it("when no missing agent is onboardable, does not mention admin.onboard_agent at all", () => {
    setEnabled("opencode", true);
    const b = buildHooksBlock({ installMode: "npm", version: "5.0.0" });
    expect(b.prompt).not.toContain("admin.onboard_agent");
    expect(b.prompt).toContain("kontexta hooks install --agent opencode");
  });
});
