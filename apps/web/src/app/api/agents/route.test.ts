import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSetting, getDatabase } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";
import { GET } from "./route";
import { PATCH } from "./[id]/route";
import { POST } from "./[id]/hooks/route";

let home: string;
const get = () => GET(new NextRequest("http://localhost/api/agents"));
const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest(`http://localhost/api/agents/${id}`, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/agents/${id}/hooks`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const enabledInDb = (id: string) => (getDatabase().prepare("SELECT enabled FROM agents WHERE id = ?").get(id) as { enabled: number } | undefined)?.enabled;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kx-agents-home-"));
  process.env.KONTEXTA_HOOKS_HOME = home;
  process.env.KONTEXTA_INSTALL_HINT = "npm";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KONTEXTA_HOOKS_HOME; delete process.env.KONTEXTA_INSTALL_HINT; delete process.env.KONTEXTA_HOST_DATA_DIR;
});

describe("GET /api/agents", () => {
  it("lists every agent disabled with the install mode and no alerts", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.install_mode).toBe("npm");
    expect(j.agents).toHaveLength(15);
    expect(j.agents.every((a: any) => a.enabled === false)).toBe(true);
    expect(j.alerts).toEqual([]);
    expect(j.docker_commands).toEqual({});
  });
});

describe("PATCH /api/agents/:id", () => {
  it("enable installs hooks immediately (npm mode)", async () => {
    const res = await patch("gemini", { enabled: true });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ agent: "gemini", enabled: true, docker_command: null });
    expect(j.install).toMatchObject({ ok: true, changed: true });
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    const state = await (await get()).json();
    const g = state.agents.find((a: any) => a.id === "gemini");
    expect(g).toMatchObject({ enabled: true, hooks_installed: true });
    expect(state.alerts).toEqual([]);
  });

  it("docker mode: never writes host files, returns the docker command", async () => {
    process.env.KONTEXTA_INSTALL_HINT = "docker";
    const j = await (await patch("gemini", { enabled: true })).json();
    expect(j.install).toBeNull();
    expect(j.docker_command).toContain("--agent gemini");
    expect(j.docker_command).toContain("--no-db");
    expect(existsSync(join(home, ".gemini"))).toBe(false);
    const state = await (await get()).json();
    expect(state.docker_commands.gemini).toBe(j.docker_command);
    expect(state.alerts.map((a: any) => a.agent)).toEqual(["gemini"]);
  });

  it("malformed config: 200 with install.ok=false, agent stays enabled, file untouched", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), "{ broken");
    const res = await patch("gemini", { enabled: true });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.install.ok).toBe(false);
    expect(j.install.error).toMatch(/not valid JSON/);
    expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).toBe("{ broken");
    expect(enabledInDb("gemini")).toBe(1);
  });

  it("agents without a hook API enable cleanly with a note and no install", async () => {
    const j = await (await patch("aider", { enabled: true })).json();
    expect(j.install).toBeNull();
    expect(j.note).toMatch(/MCP capture only/);
    expect(enabledInDb("aider")).toBe(1);
  });

  it("disable keeps the hook config in place", async () => {
    await patch("gemini", { enabled: true });
    const j = await (await patch("gemini", { enabled: false })).json();
    expect(j).toMatchObject({ enabled: false, install: null });
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    expect(enabledInDb("gemini")).toBe(0);
  });

  it("unknown id → 404 with no side effects", async () => {
    for (const id of ["nope", "../etc/passwd", "gemini; rm -rf /"]) {
      const res = await patch(id, { enabled: true });
      expect(res.status).toBe(404);
    }
    expect(readdirSafe(home)).toEqual([]);
  });

  it("invalid body → 400 and nothing changes", async () => {
    expect((await patch("gemini", { enabled: "yes" })).status).toBe(400);
    expect((await patch("gemini", "not json")).status).toBe(400);
    expect(enabledInDb("gemini")).toBe(0);
    expect(existsSync(join(home, ".gemini"))).toBe(false);
  });
});

describe("POST /api/agents/:id/hooks", () => {
  it("uninstall removes only kontexta's entries; install re-adds them", async () => {
    await patch("codex", { enabled: true });
    const un = await (await post("codex", { action: "uninstall" })).json();
    expect(un.outcome).toMatchObject({ ok: true, changed: true });
    expect(enabledInDb("codex")).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"))).toEqual({});
    const re = await (await post("codex", { action: "install" })).json();
    expect(re.outcome).toMatchObject({ ok: true, changed: true });
  });

  it("docker mode → 409 with the command, nothing written", async () => {
    process.env.KONTEXTA_INSTALL_HINT = "docker";
    const res = await post("codex", { action: "install" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.mode).toBe("docker");
    expect(j.docker_command).toContain("--agent codex");
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("rejects unsupported agents, bad actions and unknown ids", async () => {
    expect((await post("aider", { action: "install" })).status).toBe(400);
    expect((await post("codex", { action: "explode" })).status).toBe(400);
    expect((await post("nope", { action: "install" })).status).toBe(404);
  });
});

describe("authentication", () => {
  it("returns 401 on every route once a password is set, with no side effects", async () => {
    ensureDbInitialized();
    setSetting("auth_password_hash", "x");
    expect((await get()).status).toBe(401);
    expect((await patch("gemini", { enabled: true })).status).toBe(401);
    expect((await post("gemini", { action: "install" })).status).toBe(401);
    expect(enabledInDb("gemini")).toBe(0);
    expect(existsSync(join(home, ".gemini"))).toBe(false);
  });
});

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
