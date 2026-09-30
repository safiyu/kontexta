import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MCP_INSTALLERS } from "../../src/mcp-install/installers/index.js";
import type { McpCtx, Runner } from "../../src/mcp-install/types.js";

const TOOLS = [{ name: "files.read", destructive: false }, { name: "files.delete", destructive: true }, { name: "tags.list", destructive: false }];
const ENTRY = { command: "npx", args: ["-y", "kontexta-mcp"] };

describe("claude-code MCP installer", () => {
  let home: string; let calls: string[][]; let hasClaude: boolean;
  const dotClaude = () => join(home, ".claude.json");
  const settings = () => join(home, ".claude", "settings.json");
  const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  // Fake `claude` CLI: add/remove edit ~/.claude.json the way the real one does.
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (!hasClaude) return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) };
    const cfg = existsSync(dotClaude()) ? readJson(dotClaude()) : {};
    if (args[0] === "mcp" && args[1] === "add") {
      const dash = args.indexOf("--");
      const envArgs = args.slice(0, dash).reduce<string[]>((a, x, i, all) => (all[i - 1] === "-e" ? [...a, x] : a), []);
      const env = Object.fromEntries(envArgs.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), kxta: { type: "stdio", command: args[dash + 1], args: args.slice(dash + 2), env } };
      writeFileSync(dotClaude(), JSON.stringify(cfg));
    }
    if (args[0] === "mcp" && args[1] === "remove") { if (cfg.mcpServers) delete cfg.mcpServers.kxta; writeFileSync(dotClaude(), JSON.stringify(cfg)); }
    return { status: 0, stdout: "", stderr: "" };
  };
  const ctx = (over: Partial<McpCtx> = {}): McpCtx => ({ home, entry: ENTRY, approval: "prompt", previousApproval: "prompt", tools: TOOLS, version: "1", run, ...over });
  const inst = () => MCP_INSTALLERS["claude-code"];
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-cc-")); calls = []; hasClaude = true; });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("adds the server at user scope through the claude CLI", () => {
    const r = inst().install(ctx());
    expect(r.changed).toBe(true);
    expect(calls.find((c) => c[2] === "add")).toEqual(["claude", "mcp", "add", "kxta", "-s", "user", "--", "npx", "-y", "kontexta-mcp"]);
    expect(inst().status(ctx())).toMatchObject({ installed: true, current: true });
  });

  it("passes env as -e flags before the separator", () => {
    inst().install(ctx({ entry: { ...ENTRY, env: { KONTEXTA_DATA_DIR: "/d" } } }));
    const add = calls.find((c) => c[2] === "add")!;
    expect(add.slice(0, 9)).toEqual(["claude", "mcp", "add", "kxta", "-s", "user", "-e", "KONTEXTA_DATA_DIR=/d", "--"]);
  });

  it("is a no-op when already current, and re-adds (remove then add) when stale", () => {
    inst().install(ctx());
    calls = [];
    expect(inst().install(ctx()).changed).toBe(false);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    expect(inst().install(ctx({ entry: { command: "npx", args: ["-y", "kontexta", "mcp"] } })).changed).toBe(true);
    const order = calls.filter((c) => c[1] === "mcp").map((c) => c[2]);
    expect(order).toEqual(["remove", "add"]);
  });

  it("reports a missing claude CLI with the command to run by hand", () => {
    hasClaude = false;
    expect(() => inst().install(ctx())).toThrow(/claude CLI not found[\s\S]*claude mcp add kxta -s user/);
  });

  it("dry-run runs nothing", () => {
    inst().install(ctx({ dryRun: true }));
    expect(calls).toEqual([]);
    expect(existsSync(dotClaude())).toBe(false);
  });

  it("uninstall removes the server and kxta permission rules only", () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings(), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    inst().install(ctx({ approval: "all" }));
    expect(readJson(settings()).permissions.allow).toEqual(["Bash(ls)", "mcp__kxta"]);
    expect(inst().uninstall(ctx({ previousApproval: "all" })).changed).toBe(true);
    expect(readJson(dotClaude()).mcpServers.kxta).toBeUndefined();
    expect(readJson(settings()).permissions.allow).toEqual(["Bash(ls)"]);
  });

  it("all writes the server-level permission, safe writes per-tool rules with dots as underscores", () => {
    inst().install(ctx({ approval: "all" }));
    expect(readJson(settings()).permissions.allow).toEqual(["mcp__kxta"]);
    inst().install(ctx({ approval: "safe", previousApproval: "all" }));
    expect(readJson(settings()).permissions.allow).toEqual(["mcp__kxta__files_read", "mcp__kxta__tags_list"]);
    inst().install(ctx({ approval: "prompt", previousApproval: "safe" }));
    expect(readJson(settings()).permissions).toBeUndefined();
  });

  it("uninstall keeps a hand-written kxta permission when no approval level was applied", () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings(), JSON.stringify({ permissions: { allow: ["mcp__kxta__files_read"] } }));
    inst().install(ctx());
    inst().uninstall(ctx({ previousApproval: "prompt" }));
    expect(readJson(settings()).permissions.allow).toEqual(["mcp__kxta__files_read"]);
  });

  it("sees a server registered only for one project, without calling it current", () => {
    writeFileSync(dotClaude(), JSON.stringify({ projects: { "/some/project": { mcpServers: { kxta: { type: "stdio", command: "npx", args: ["-y", "kontexta-mcp"] } } } } }));
    expect(inst().status(ctx())).toMatchObject({ installed: true, current: false });
    expect(inst().status(ctx()).notes.join(" ")).toMatch(/project/i);
  });

  it("prompt never creates a settings file", () => {
    inst().install(ctx());
    expect(existsSync(settings())).toBe(false);
  });
});
