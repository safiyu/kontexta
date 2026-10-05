import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { MCP_INSTALLERS } from "../../src/mcp-install/installers/index.js";
import type { McpCtx } from "../../src/mcp-install/types.js";
import { MalformedConfigError } from "../../src/hooks/installers/json-config.js";

const TOOLS = [
  { name: "files_read", destructive: false },
  { name: "files_delete", destructive: true },
  { name: "tags_list", destructive: false },
];
const ENTRY = { command: "npx", args: ["-y", "kontexta-mcp"] };
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe.each([
  { id: "cursor", rel: [".cursor", "mcp.json"] },
  { id: "cline", rel: [".cline", "mcp_settings.json"] },
  { id: "gemini", rel: [".gemini", "settings.json"] },
  { id: "copilot", rel: [".copilot", "mcp-config.json"] },
  { id: "claude-desktop", rel: ["Library", "Application Support", "Claude", "claude_desktop_config.json"] },
])("JSON mcpServers installer: $id", ({ id, rel }) => {
  let home: string;
  const inst = () => MCP_INSTALLERS[id];
  const ctx = (over: Partial<McpCtx> = {}): McpCtx => ({ home, entry: ENTRY, approval: "prompt", previousApproval: "prompt", tools: TOOLS, version: "5.1.0", platform: "darwin", ...over });
  const cfg = () => join(home, ...rel);
  const mkAppDir = () => mkdirSync(dirname(cfg()), { recursive: true });
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-mcp-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("resolves its documented config path", () => { expect(inst().configPath(ctx())).toBe(cfg()); });

  it("refuses when the agent's config folder does not exist instead of inventing a config", () => {
    expect(() => inst().install(ctx())).toThrow(/not found/i);
    expect(existsSync(dirname(cfg()))).toBe(false);
  });

  it("writes mcpServers.kxta and reports installed/current", () => {
    mkAppDir();
    const r = inst().install(ctx());
    expect(r.changed).toBe(true);
    expect(read(cfg()).mcpServers.kxta).toMatchObject(ENTRY);
    expect(inst().status(ctx())).toMatchObject({ installed: true, current: true });
  });

  it("keeps other servers and unrelated keys, and a second install is a no-op", () => {
    mkAppDir();
    writeFileSync(cfg(), JSON.stringify({ theme: "x", mcpServers: { other: { command: "o" } } }));
    inst().install(ctx());
    expect(inst().install(ctx()).changed).toBe(false);
    const c = read(cfg());
    expect(c.theme).toBe("x");
    expect(c.mcpServers.other).toEqual({ command: "o" });
  });

  it("updates a stale entry and drops env that is no longer wanted", () => {
    mkAppDir();
    writeFileSync(cfg(), JSON.stringify({ mcpServers: { kxta: { command: "old", args: [], env: { KONTEXTA_DATA_DIR: "/x" } } } }));
    expect(inst().status(ctx())).toMatchObject({ installed: true, current: false });
    inst().install(ctx());
    expect(read(cfg()).mcpServers.kxta.env).toBeUndefined();
    expect(read(cfg()).mcpServers.kxta.command).toBe("npx");
  });

  it("uninstall removes only kxta and tidies an emptied mcpServers", () => {
    mkAppDir();
    writeFileSync(cfg(), JSON.stringify({ keep: 1, mcpServers: { other: { command: "o" } } }));
    inst().install(ctx());
    expect(inst().uninstall(ctx()).changed).toBe(true);
    expect(read(cfg())).toEqual({ keep: 1, mcpServers: { other: { command: "o" } } });
    inst().install(ctx());
    rmSync(cfg()); mkAppDir(); writeFileSync(cfg(), JSON.stringify({ mcpServers: { kxta: ENTRY } }));
    inst().uninstall(ctx());
    expect(read(cfg()).mcpServers).toBeUndefined();
  });

  it("keeps a one-time backup of the original file before its first change, never overwritten", () => {
    mkAppDir();
    writeFileSync(cfg(), JSON.stringify({ theme: "x" }));
    inst().install(ctx());
    expect(read(`${cfg()}.kontexta-bak`)).toEqual({ theme: "x" });
    inst().install(ctx({ entry: { command: "node", args: ["x"] } }));
    expect(read(`${cfg()}.kontexta-bak`)).toEqual({ theme: "x" });
  });

  it("makes no backup when it creates the file or when nothing changes", () => {
    mkAppDir();
    inst().install(ctx());
    inst().install(ctx());
    expect(existsSync(`${cfg()}.kontexta-bak`)).toBe(false);
  });

  it("only manages KONTEXTA_DATA_DIR inside env: env keys the user added survive", () => {
    mkAppDir();
    writeFileSync(cfg(), JSON.stringify({ mcpServers: { kxta: { command: "npx", args: [], env: { FOO: "1", KONTEXTA_DATA_DIR: "/old" } } } }));
    inst().install(ctx());
    expect(read(cfg()).mcpServers.kxta.env).toEqual({ FOO: "1" });
    inst().install(ctx({ entry: { ...ENTRY, env: { KONTEXTA_DATA_DIR: "/d" } } }));
    expect(read(cfg()).mcpServers.kxta.env).toEqual({ FOO: "1", KONTEXTA_DATA_DIR: "/d" });
  });

  it("reads a config that starts with a UTF-8 BOM", () => {
    mkAppDir();
    writeFileSync(cfg(), "\uFEFF" + JSON.stringify({ theme: "x" }));
    inst().install(ctx());
    expect(read(cfg()).theme).toBe("x");
  });

  it("refuses malformed JSON or a non-object mcpServers, and dry-run writes nothing", () => {
    mkAppDir();
    writeFileSync(cfg(), "{ nope");
    expect(() => inst().install(ctx())).toThrow(MalformedConfigError);
    writeFileSync(cfg(), JSON.stringify({ mcpServers: [] }));
    expect(() => inst().install(ctx())).toThrow(/mcpServers/);
    rmSync(cfg());
    inst().install(ctx({ dryRun: true }));
    expect(existsSync(cfg())).toBe(false);
  });
});

describe("documented per-agent entry fields", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-mcp-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const base = (over: Partial<McpCtx> = {}): McpCtx => ({ home, entry: ENTRY, approval: "prompt", previousApproval: "prompt", tools: TOOLS, version: "1", ...over });

  it("cursor entries carry the documented type: stdio", () => {
    mkdirSync(join(home, ".cursor"));
    MCP_INSTALLERS.cursor.install(base());
    expect(read(join(home, ".cursor", "mcp.json")).mcpServers.kxta.type).toBe("stdio");
  });

  it("copilot entries are type local with all tools enabled, and a user-customised tools list survives", () => {
    mkdirSync(join(home, ".copilot"));
    MCP_INSTALLERS.copilot.install(base());
    const p = join(home, ".copilot", "mcp-config.json");
    expect(read(p).mcpServers.kxta).toMatchObject({ type: "local", tools: ["*"], command: "npx" });
    writeFileSync(p, JSON.stringify({ mcpServers: { kxta: { type: "local", command: "x", tools: ["files_read"] } } }));
    MCP_INSTALLERS.copilot.install(base());
    expect(read(p).mcpServers.kxta.tools).toEqual(["files_read"]);
  });

  it("copilot honours COPILOT_HOME and asks for an explicit data dir because only PATH is inherited", () => {
    const alt = mkdtempSync(join(tmpdir(), "kontexta-copilot-home-"));
    try {
      expect(MCP_INSTALLERS.copilot.configPath(base({ env: { COPILOT_HOME: alt } }))).toBe(join(alt, "mcp-config.json"));
      expect(MCP_INSTALLERS.copilot.entryHints).toEqual({ forceEnv: true });
    } finally { rmSync(alt, { recursive: true, force: true }); }
  });
});

describe("claude-desktop paths by platform", () => {
  const i = MCP_INSTALLERS["claude-desktop"];
  const base = { entry: ENTRY, approval: "prompt" as const, previousApproval: "prompt" as const, tools: TOOLS, version: "1" };
  it("windows uses APPDATA, linux is unsupported", () => {
    expect(i.configPath({ ...base, home: "C:/u", platform: "win32", env: { APPDATA: "C:/u/AppData/Roaming" } })).toMatch(/AppData[\\/]Roaming[\\/]Claude[\\/]claude_desktop_config\.json$/);
    expect(() => i.configPath({ ...base, home: "/h", platform: "linux" })).toThrow(/Linux/);
  });
});

describe("gemini allowlist (permissions.allow)", () => {
  let home: string;
  const path = () => join(home, ".gemini", "settings.json");
  const ctx = (approval: McpCtx["approval"], previousApproval: McpCtx["approval"] = "prompt"): McpCtx => ({ home, entry: ENTRY, approval, previousApproval, tools: TOOLS, version: "1" });
  const allow = () => read(path()).permissions?.allow;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-mcp-")); mkdirSync(join(home, ".gemini")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("prompt adds no rules and creates no permissions block", () => {
    MCP_INSTALLERS.gemini.install(ctx("prompt"));
    expect(read(path()).permissions).toBeUndefined();
  });

  it("all writes the single wildcard rule", () => {
    MCP_INSTALLERS.gemini.install(ctx("all"));
    expect(allow()).toEqual(["mcp(kxta/*)"]);
  });

  it("safe writes explicit rules for non-destructive tools only", () => {
    MCP_INSTALLERS.gemini.install(ctx("safe"));
    expect(allow()).toEqual(["mcp(kxta/files_read)", "mcp(kxta/tags_list)"]);
  });

  it("keeps the user's own rules, is idempotent, and switching level replaces only kxta rules", () => {
    writeFileSync(path(), JSON.stringify({ permissions: { allow: ["command(ls)", "mcp(other/*)"] } }));
    MCP_INSTALLERS.gemini.install(ctx("all"));
    expect(MCP_INSTALLERS.gemini.install(ctx("all", "all")).changed).toBe(false);
    MCP_INSTALLERS.gemini.install(ctx("safe", "all"));
    expect(allow()).toEqual(["command(ls)", "mcp(other/*)", "mcp(kxta/files_read)", "mcp(kxta/tags_list)"]);
  });

  it("prompt after prompt leaves hand-written kxta rules alone; prompt after all removes ours", () => {
    writeFileSync(path(), JSON.stringify({ permissions: { allow: ["mcp(kxta/files_read)"] } }));
    MCP_INSTALLERS.gemini.install(ctx("prompt", "prompt"));
    expect(allow()).toEqual(["mcp(kxta/files_read)"]);
    MCP_INSTALLERS.gemini.install(ctx("prompt", "all"));
    expect(read(path()).permissions).toBeUndefined();
  });

  it("uninstall removes the kxta server and its rules but nothing else", () => {
    writeFileSync(path(), JSON.stringify({ hooks: { Stop: [] }, permissions: { allow: ["command(ls)"] } }));
    MCP_INSTALLERS.gemini.install(ctx("all"));
    MCP_INSTALLERS.gemini.uninstall(ctx("prompt", "all"));
    expect(read(path())).toEqual({ hooks: { Stop: [] }, permissions: { allow: ["command(ls)"] } });
  });

  it("uninstall keeps a hand-written kxta rule when we never applied an approval level", () => {
    writeFileSync(path(), JSON.stringify({ permissions: { allow: ["mcp(kxta/files_read)"] } }));
    MCP_INSTALLERS.gemini.install(ctx("prompt"));
    MCP_INSTALLERS.gemini.uninstall(ctx("prompt", "prompt"));
    expect(allow()).toEqual(["mcp(kxta/files_read)"]);
  });
});

describe("cline alwaysAllow", () => {
  let home: string;
  const path = () => join(home, ".cline", "mcp_settings.json");
  const ctx = (approval: McpCtx["approval"], previousApproval: McpCtx["approval"] = "prompt"): McpCtx => ({ home, entry: ENTRY, approval, previousApproval, tools: TOOLS, version: "1" });
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-mcp-")); mkdirSync(join(home, ".cline")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("all lists every tool, safe skips destructive ones, prompt leaves it absent", () => {
    MCP_INSTALLERS.cline.install(ctx("all"));
    expect(read(path()).mcpServers.kxta.alwaysAllow).toEqual(["files_read", "files_delete", "tags_list"]);
    MCP_INSTALLERS.cline.install(ctx("safe", "all"));
    expect(read(path()).mcpServers.kxta.alwaysAllow).toEqual(["files_read", "tags_list"]);
    MCP_INSTALLERS.cline.install(ctx("prompt", "safe"));
    expect(read(path()).mcpServers.kxta.alwaysAllow).toBeUndefined();
  });

  it("prompt after prompt keeps a hand-set alwaysAllow and other fields like disabled", () => {
    writeFileSync(path(), JSON.stringify({ mcpServers: { kxta: { command: "x", disabled: false, alwaysAllow: ["files_read"] } } }));
    MCP_INSTALLERS.cline.install(ctx("prompt", "prompt"));
    expect(read(path()).mcpServers.kxta).toMatchObject({ command: "npx", disabled: false, alwaysAllow: ["files_read"] });
  });
});
