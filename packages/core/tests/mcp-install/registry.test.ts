import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { AGENTS } from "../../src/hooks/agents.js";
import { syncAgentRows, listAgents, setEnabled, markMcpInstalled, markMcpUninstalled, setMcpApproval, mcpAlerts } from "../../src/hooks/registry.js";

describe("MCP registry state", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kontexta-mcpreg-")); createDatabase(join(dir, "t.db")); syncAgentRows(); });
  afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });
  const row = (id: string) => listAgents().find((r) => r.id === id)!;

  it("flags exactly the Phase 1 agents as MCP-installable", () => {
    const ids = AGENTS.filter((a) => a.mcpInstallable).map((a) => a.id).sort();
    expect(ids).toEqual(["claude-code", "claude-desktop", "cline", "codex", "continue", "copilot", "cursor", "gemini", "hermes"]);
    expect(row("cursor").mcp_supported).toBe(true);
    expect(row("aider").mcp_supported).toBe(false);
    expect(row("cursor").mcp_installed).toBe(false);
    expect(row("cursor").mcp_approval).toBe("prompt");
  });

  it("markMcpInstalled records signature and approval; uninstall resets them but keeps the agent enabled", () => {
    setEnabled("gemini", true);
    markMcpInstalled("gemini", "sig1", "safe");
    expect(row("gemini")).toMatchObject({ mcp_installed: true, mcp_version: "sig1", mcp_approval: "safe" });
    expect(row("gemini").mcp_installed_at).toBeTruthy();
    markMcpUninstalled("gemini");
    expect(row("gemini")).toMatchObject({ enabled: true, mcp_installed: false, mcp_version: null, mcp_approval: "prompt" });
  });

  it("setMcpApproval validates the level and the agent", () => {
    setMcpApproval("cline", "all");
    expect(row("cline").mcp_approval).toBe("all");
    expect(() => setMcpApproval("cline", "yolo" as never)).toThrow(/approval/);
    expect(() => setMcpApproval("nope", "all")).toThrow(/unknown agent/);
  });

  it("re-sync keeps installed state and refreshes mcp_supported", () => {
    markMcpInstalled("cursor", "s", "prompt");
    syncAgentRows();
    expect(row("cursor").mcp_installed).toBe(true);
  });

  it("mcpAlerts lists enabled, installable agents that are not installed", () => {
    setEnabled("cursor", true); setEnabled("gemini", true); setEnabled("aider", true);
    markMcpInstalled("gemini", "s", "prompt");
    expect(mcpAlerts().map((r) => r.id)).toEqual(["cursor"]);
  });
});
