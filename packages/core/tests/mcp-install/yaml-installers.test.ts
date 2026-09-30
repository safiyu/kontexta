import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { MCP_INSTALLERS } from "../../src/mcp-install/installers/index.js";
import type { McpCtx } from "../../src/mcp-install/types.js";

const ENTRY = { command: "npx", args: ["-y", "kontexta-mcp"], env: { KONTEXTA_DATA_DIR: "/d" } };
let home: string;
const ctx = (over: Partial<McpCtx> = {}): McpCtx => ({ home, entry: ENTRY, approval: "prompt", previousApproval: "prompt", tools: [], version: "5.1.0", ...over });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-yaml-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("continue (owns ~/.continue/mcpServers/kontexta.yaml)", () => {
  const inst = () => MCP_INSTALLERS.continue;
  const file = () => join(home, ".continue", "mcpServers", "kontexta.yaml");
  const mkDir = () => mkdirSync(join(home, ".continue"));

  it("refuses when ~/.continue does not exist", () => {
    expect(() => inst().install(ctx())).toThrow(/not found/i);
    expect(existsSync(join(home, ".continue"))).toBe(false);
  });

  it("writes a valid block with the kxta server and is idempotent", () => {
    mkDir();
    expect(inst().install(ctx()).changed).toBe(true);
    const doc = parse(readFileSync(file(), "utf8"));
    expect(doc).toMatchObject({ name: "kontexta", version: "5.1.0", schema: "v1" });
    expect(doc.mcpServers).toEqual([{ name: "kxta", command: "npx", args: ["-y", "kontexta-mcp"], env: { KONTEXTA_DATA_DIR: "/d" } }]);
    expect(inst().install(ctx()).changed).toBe(false);
    expect(inst().status(ctx())).toMatchObject({ installed: true, current: true });
  });

  it("updates a stale entry", () => {
    mkDir();
    inst().install(ctx());
    expect(inst().status(ctx({ entry: { command: "node", args: ["x"] } })).current).toBe(false);
    inst().install(ctx({ entry: { command: "node", args: ["x"] } }));
    expect(parse(readFileSync(file(), "utf8")).mcpServers[0]).toEqual({ name: "kxta", command: "node", args: ["x"] });
  });

  it("an empty kontexta.yaml is safe to overwrite", () => {
    mkDir(); mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), "");
    expect(inst().install(ctx()).changed).toBe(true);
    expect(parse(readFileSync(file(), "utf8")).name).toBe("kontexta");
  });

  it("will not overwrite a file that is not ours, and uninstall leaves it", () => {
    mkDir(); mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), "name: mine\nschema: v1\n");
    expect(() => inst().install(ctx())).toThrow(/not created by kontexta/i);
    expect(inst().uninstall(ctx()).changed).toBe(false);
    expect(readFileSync(file(), "utf8")).toContain("name: mine");
  });

  it("uninstall deletes our file; dry-run writes nothing", () => {
    mkDir();
    inst().install(ctx({ dryRun: true }));
    expect(existsSync(file())).toBe(false);
    inst().install(ctx());
    expect(inst().uninstall(ctx()).changed).toBe(true);
    expect(existsSync(file())).toBe(false);
  });
});

describe("hermes (mcp_servers in ~/.hermes/config.yaml)", () => {
  const inst = () => MCP_INSTALLERS.hermes;
  const file = () => join(home, ".hermes", "config.yaml");
  const seed = (t: string) => { mkdirSync(dirname(file()), { recursive: true }); writeFileSync(file(), t); };
  const load = () => parse(readFileSync(file(), "utf8"));

  it("asks for env and absolute commands because Hermes strips the MCP environment", () => {
    expect(inst().entryHints).toEqual({ forceEnv: true, absolute: true });
  });

  it("refuses when ~/.hermes does not exist", () => {
    expect(() => inst().install(ctx())).toThrow(/not found/i);
  });

  it("adds mcp_servers.kxta, keeping comments, other keys and other servers; second run is a no-op", () => {
    seed("# my config\nmodel: sonnet  # default\nmcp_servers:\n  github:\n    command: npx  # keep\n    args: [\"-y\", \"gh\"]\n");
    expect(inst().install(ctx()).changed).toBe(true);
    const text = readFileSync(file(), "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain("# default");
    expect(text).toContain("# keep");
    expect(load().mcp_servers.kxta).toEqual({ command: "npx", args: ["-y", "kontexta-mcp"], env: { KONTEXTA_DATA_DIR: "/d" } });
    expect(load().mcp_servers.github.command).toBe("npx");
    expect(inst().install(ctx()).changed).toBe(false);
    expect(inst().status(ctx())).toMatchObject({ installed: true, current: true });
  });

  it("keeps extra keys the user put on the kxta entry", () => {
    seed("mcp_servers:\n  kxta:\n    command: old\n    args: []\n    timeout: 90\n    env:\n      FOO: bar\n");
    inst().install(ctx());
    expect(load().mcp_servers.kxta).toEqual({ command: "npx", args: ["-y", "kontexta-mcp"], timeout: 90, env: { FOO: "bar", KONTEXTA_DATA_DIR: "/d" } });
  });

  it("keeps a one-time backup of the original config.yaml", () => {
    seed("# mine\nmodel: x\n");
    inst().install(ctx());
    expect(readFileSync(`${file()}.kontexta-bak`, "utf8")).toBe("# mine\nmodel: x\n");
  });

  it("creates the mcp_servers block when missing and keeps it on one line per command", () => {
    seed("model: x\n");
    inst().install(ctx({ entry: { command: "/opt/homebrew/bin/npx", args: ["-y", "kontexta-mcp"], env: { KONTEXTA_DATA_DIR: "/a/very/long/path/to/a/data/directory/that/would/normally/fold/in/yaml" } } }));
    expect(readFileSync(file(), "utf8")).toMatch(/KONTEXTA_DATA_DIR: .*directory\/that\/would\/normally\/fold\/in\/yaml/);
  });

  it("uninstall removes only kxta and drops an emptied mcp_servers", () => {
    seed("# keep\nmcp_servers:\n  github:\n    command: g\n");
    inst().install(ctx());
    inst().uninstall(ctx());
    expect(load().mcp_servers).toEqual({ github: { command: "g" } });
    expect(readFileSync(file(), "utf8")).toContain("# keep");
    seed("mcp_servers:\n  kxta:\n    command: x\n");
    inst().uninstall(ctx());
    expect(load()?.mcp_servers).toBeUndefined();
  });

  it("refuses invalid YAML and a non-mapping mcp_servers; dry-run writes nothing", () => {
    seed("mcp_servers: [oops\n");
    expect(() => inst().install(ctx())).toThrow(/not valid YAML/);
    seed("mcp_servers: nope\n");
    expect(() => inst().install(ctx())).toThrow(/mcp_servers/);
    seed("model: x\n");
    inst().install(ctx({ dryRun: true }));
    expect(readFileSync(file(), "utf8")).toBe("model: x\n");
  });
});
