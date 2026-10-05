import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSetting } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";
import { GET } from "../../route";
import { PATCH } from "../route";
import { POST } from "./route";

let home: string;
const get = () => GET(new NextRequest("http://localhost/api/agents"));
const post = (id: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/agents/${id}/mcp`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const row = async (id: string) => (await (await get()).json()).agents.find((a: any) => a.id === id);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kx-mcp-home-"));
  process.env.KONTEXTA_HOOKS_HOME = home;
  process.env.KONTEXTA_INSTALL_HINT = "npm";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KONTEXTA_HOOKS_HOME; delete process.env.KONTEXTA_INSTALL_HINT; delete process.env.KONTEXTA_HOST_DATA_DIR;
});

describe("GET /api/agents (MCP fields)", () => {
  it("adds MCP state, the destructive tool list and no docker commands in npm mode", async () => {
    const j = await (await get()).json();
    const cursor = j.agents.find((a: any) => a.id === "cursor");
    expect(cursor).toMatchObject({ mcp_supported: true, mcp_installed: false, mcp_approval: "prompt", mcp_approval_supported: false });
    expect(j.agents.find((a: any) => a.id === "gemini").mcp_approval_supported).toBe(true);
    expect(j.agents.find((a: any) => a.id === "aider").mcp_supported).toBe(false);
    expect(j.agents.find((a: any) => a.id === "codex").mcp_supported).toBe(true);
    expect(j.destructive_tools).toContain("files_delete");
    expect(j.destructive_tools).not.toContain("files_read");
    expect(j.mcp_docker_commands).toEqual({});
    expect(j.mcp_alerts).toEqual([]);
  });

  it("alerts for enabled, MCP-capable agents that are not connected", async () => {
    await PATCH(new NextRequest("http://localhost/api/agents/cursor", { method: "PATCH", body: JSON.stringify({ enabled: true }) }), { params: Promise.resolve({ id: "cursor" }) });
    const j = await (await get()).json();
    expect(j.mcp_alerts).toEqual([{ agent: "cursor", name: "Cursor" }]);
  });
});

describe("POST /api/agents/:id/mcp", () => {
  it("installs the server and reflects it in the agents state", async () => {
    mkdirSync(join(home, ".cursor"));
    const res = await post("cursor", { action: "install" });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.outcome).toMatchObject({ ok: true, changed: true, approval: "prompt" });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.kxta.args).toEqual(["-y", "kontexta", "mcp"]);
    expect(await row("cursor")).toMatchObject({ mcp_installed: true, mcp_current: true });
  });

  it("connects from a source checkout that was never bootstrapped (finds apps/mcp/dist/index.js itself)", async () => {
    process.env.KONTEXTA_INSTALL_HINT = "source";
    mkdirSync(join(home, ".cursor"));
    const j = await (await post("cursor", { action: "install" })).json();
    expect(j.outcome, JSON.stringify(j)).toMatchObject({ ok: true, changed: true });
    const args = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.kxta.args;
    expect(args[0]).toMatch(/apps[\\/]mcp[\\/]dist[\\/]index\.js$/);
  });

  it("a server the user configured by hand shows as present, raises no alert, and is not marked managed", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { kxta: { command: "my-own", args: [] } } }));
    await PATCH(new NextRequest("http://localhost/api/agents/cursor", { method: "PATCH", body: JSON.stringify({ enabled: true }) }), { params: Promise.resolve({ id: "cursor" }) });
    const state = await (await get()).json();
    expect(state.agents.find((a: any) => a.id === "cursor")).toMatchObject({ mcp_present: true, mcp_installed: false, mcp_current: false });
    expect(state.mcp_alerts).toEqual([]);
  });

  it("applies an approval level where supported", async () => {
    mkdirSync(join(home, ".gemini"));
    const j = await (await post("gemini", { action: "install", approval: "all" })).json();
    expect(j.outcome).toMatchObject({ ok: true, approval: "all" });
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).permissions.allow).toEqual(["mcp(kxta/*)"]);
    expect(await row("gemini")).toMatchObject({ mcp_approval: "all" });
  });

  it("reports a missing agent folder as a failed outcome without creating anything", async () => {
    const res = await post("cursor", { action: "install" });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toMatchObject({ ok: false });
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("uninstall removes the entry", async () => {
    mkdirSync(join(home, ".cursor"));
    await post("cursor", { action: "install" });
    const j = await (await post("cursor", { action: "uninstall" })).json();
    expect(j.outcome).toMatchObject({ ok: true, changed: true });
    expect(await row("cursor")).toMatchObject({ mcp_installed: false });
  });

  it("docker mode → 409 with the host command (and approval), nothing written", async () => {
    process.env.KONTEXTA_INSTALL_HINT = "docker";
    const res = await post("gemini", { action: "install", approval: "safe" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.mode).toBe("docker");
    expect(j.docker_command).toContain("connect install");
    expect(j.docker_command).toContain("--agent gemini");
    expect(j.docker_command).toMatch(/--approval safe$/);
    expect(existsSync(join(home, ".gemini"))).toBe(false);
    expect((await (await get()).json()).mcp_docker_commands.gemini).toContain("connect install");
  });

  it("rejects bad input: unsupported agent, action, approval, body; unknown id", async () => {
    expect((await post("aider", { action: "install" })).status).toBe(400);
    expect((await post("cursor", { action: "explode" })).status).toBe(400);
    expect((await post("cursor", { action: "install", approval: "yolo" })).status).toBe(400);
    expect((await post("cursor", "not json")).status).toBe(400);
    expect((await post("nope", { action: "install" })).status).toBe(404);
    expect((await post("../etc/passwd", { action: "install" })).status).toBe(404);
  });

  it("returns 401 once a password is set, with no side effects", async () => {
    ensureDbInitialized();
    mkdirSync(join(home, ".cursor"));
    setSetting("auth_password_hash", "x");
    expect((await post("cursor", { action: "install" })).status).toBe(401);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});
