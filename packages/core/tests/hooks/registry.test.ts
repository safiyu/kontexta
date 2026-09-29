import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { AGENTS } from "../../src/hooks/agents.js";
import {
  syncAgentRows, listAgents, setEnabled, markInstalled, markUninstalled, markVerified, alerts,
} from "../../src/hooks/registry.js";

describe("hooks registry", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kontexta-agents-")); createDatabase(join(dir, "t.db")); });
  afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

  it("seeds every canonical agent disabled, with hooks_supported from the list", () => {
    syncAgentRows();
    const rows = listAgents();
    expect(rows.map((r) => r.id).sort()).toEqual(AGENTS.map((a) => a.id).sort());
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    expect(rows.find((r) => r.id === "claude-code")!.hooks_supported).toBe(true);
    expect(rows.find((r) => r.id === "aider")!.hooks_supported).toBe(false);
  });

  it("re-sync never flips enabled but refreshes hooks_supported", () => {
    syncAgentRows();
    setEnabled("codex", true);
    getDatabase().prepare("UPDATE agents SET hooks_supported = 0 WHERE id = 'codex'").run();
    syncAgentRows();
    const codex = listAgents().find((r) => r.id === "codex")!;
    expect(codex.enabled).toBe(true);
    expect(codex.hooks_supported).toBe(true);
  });

  it("markInstalled / markUninstalled round-trip", () => {
    syncAgentRows();
    markInstalled("gemini", "5.1.0");
    let g = listAgents().find((r) => r.id === "gemini")!;
    expect(g.hooks_installed).toBe(true);
    expect(g.hooks_version).toBe("5.1.0");
    expect(g.hooks_installed_at).toBeTruthy();
    markUninstalled("gemini");
    g = listAgents().find((r) => r.id === "gemini")!;
    expect(g.hooks_installed).toBe(false);
    expect(g.hooks_version).toBeNull();
  });

  it("markUninstalled also turns the agent off and forgets verification, so reconcile can't quietly reinstall it", () => {
    syncAgentRows();
    setEnabled("gemini", true); markInstalled("gemini", "x"); markVerified("gemini", "2026-09-29T10:00:00.000Z");
    markUninstalled("gemini");
    const g = listAgents().find((r) => r.id === "gemini")!;
    expect(g).toMatchObject({ enabled: false, hooks_installed: false, hooks_verified_at: null });
  });

  it("markVerified sets verified_at once and always bumps last_hook_event_at", () => {
    syncAgentRows();
    markVerified("cursor", "2026-09-29T10:00:00.000Z");
    markVerified("cursor", "2026-09-29T11:00:00.000Z");
    const c = listAgents().find((r) => r.id === "cursor")!;
    expect(c.hooks_verified_at).toBe("2026-09-29T10:00:00.000Z");
    expect(c.last_hook_event_at).toBe("2026-09-29T11:00:00.000Z");
  });

  it("markVerified ignores unknown agent ids", () => {
    syncAgentRows();
    expect(() => markVerified("nope", "2026-09-29T10:00:00.000Z")).not.toThrow();
  });

  it("alerts(): enabled+supported+not installed, or installed >7d and never verified", () => {
    syncAgentRows();
    const now = new Date("2026-09-29T12:00:00.000Z");
    setEnabled("claude-code", true);
    setEnabled("gemini", true); markInstalled("gemini", "5.1.0");
    setEnabled("codex", true); markInstalled("codex", "5.1.0");
    getDatabase().prepare("UPDATE agents SET hooks_installed_at = '2026-09-01T00:00:00.000Z' WHERE id = 'codex'").run();
    setEnabled("cursor", true); markInstalled("cursor", "5.1.0");
    getDatabase().prepare("UPDATE agents SET hooks_installed_at = '2026-09-01T00:00:00.000Z' WHERE id = 'cursor'").run();
    markVerified("cursor", "2026-09-02T00:00:00.000Z");
    setEnabled("aider", true);
    expect(alerts(now).map((r) => r.id).sort()).toEqual(["claude-code", "codex"]);
  });

  it("alerts(): an enabled, not-installed agent whose events are arriving is healthy", () => {
    syncAgentRows();
    setEnabled("gemini", true);
    markVerified("gemini", "2026-09-29T10:00:00.000Z");
    expect(alerts(new Date("2026-09-29T12:00:00.000Z"))).toEqual([]);
  });
});
