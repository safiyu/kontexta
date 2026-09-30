import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "smol-toml";
import { MCP_INSTALLERS } from "../../src/mcp-install/installers/index.js";
import type { McpCtx, Runner } from "../../src/mcp-install/types.js";

const ENTRY = { command: "npx", args: ["-y", "kontexta-mcp"] };

describe("codex MCP installer (codex mcp add, config.toml read-only)", () => {
  let home: string; let calls: string[][]; let hasCodex: boolean;
  const toml = () => join(home, ".codex", "config.toml");
  // Fake `codex` CLI: add/remove edit config.toml the way the real one does.
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (!hasCodex) return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) };
    const cfg: any = existsSync(toml()) ? parse(readFileSync(toml(), "utf8")) : {};
    if (args[0] === "mcp" && args[1] === "add") {
      const dash = args.indexOf("--");
      const env = Object.fromEntries(args.slice(0, dash).flatMap((x, i, all) => (all[i - 1] === "--env" ? [x.split(/=(.*)/s).slice(0, 2)] : [])));
      const entry: any = { command: args[dash + 1], args: args.slice(dash + 2) };
      if (Object.keys(env).length > 0) entry.env = env;
      cfg.mcp_servers = { ...(cfg.mcp_servers ?? {}), [args[2]]: entry };
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(toml(), stringify(cfg));
    }
    if (args[0] === "mcp" && args[1] === "remove") { if (cfg.mcp_servers) delete cfg.mcp_servers[args[2]]; writeFileSync(toml(), stringify(cfg)); }
    return { status: 0, stdout: "", stderr: "" };
  };
  const ctx = (over: Partial<McpCtx> = {}): McpCtx => ({ home, entry: ENTRY, approval: "prompt", previousApproval: "prompt", tools: [], version: "1", run, ...over });
  const inst = () => MCP_INSTALLERS.codex;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-codex-")); calls = []; hasCodex = true; });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("adds the server through the codex CLI", () => {
    expect(inst().install(ctx()).changed).toBe(true);
    expect(calls.find((c) => c[2] === "add")).toEqual(["codex", "mcp", "add", "kxta", "--", "npx", "-y", "kontexta-mcp"]);
    expect(inst().status(ctx())).toMatchObject({ installed: true, current: true });
    expect(inst().configPath(ctx())).toBe(toml());
  });

  it("passes env as --env flags before the separator", () => {
    inst().install(ctx({ entry: { ...ENTRY, env: { KONTEXTA_DATA_DIR: "/d" } } }));
    expect(calls.find((c) => c[2] === "add")!.slice(0, 7)).toEqual(["codex", "mcp", "add", "kxta", "--env", "KONTEXTA_DATA_DIR=/d", "--"]);
  });

  it("is a no-op when current; remove then add when stale", () => {
    inst().install(ctx());
    calls = [];
    expect(inst().install(ctx()).changed).toBe(false);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    expect(inst().install(ctx({ entry: { command: "npx", args: ["-y", "kontexta", "mcp"] } })).changed).toBe(true);
    expect(calls.filter((c) => c[1] === "mcp").map((c) => c[2])).toEqual(["remove", "add"]);
  });

  it("names the manual command when codex is not on PATH; dry-run runs nothing", () => {
    hasCodex = false;
    expect(() => inst().install(ctx())).toThrow(/codex CLI not found[\s\S]*codex mcp add kxta/);
    hasCodex = true; calls = [];
    inst().install(ctx({ dryRun: true }));
    expect(calls).toEqual([]);
  });

  it("uninstall removes only kxta and leaves other servers", () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(toml(), stringify({ mcp_servers: { other: { command: "o", args: [] } } }));
    inst().install(ctx());
    expect(inst().uninstall(ctx()).changed).toBe(true);
    expect((parse(readFileSync(toml(), "utf8")) as any).mcp_servers).toEqual({ other: { command: "o", args: [] } });
  });

  it("honours CODEX_HOME", () => {
    const alt = mkdtempSync(join(tmpdir(), "kontexta-codex-home-"));
    try { expect(inst().configPath(ctx({ env: { CODEX_HOME: alt } }))).toBe(join(alt, "config.toml")); } finally { rmSync(alt, { recursive: true, force: true }); }
  });
});
