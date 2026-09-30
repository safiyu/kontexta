import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServerEntry, entrySignature } from "../../src/mcp-install/entry.js";
import { KXTA_TOOLS } from "../../src/mcp-install/tools.generated.js";

const base = { version: "5.1.0", dataDir: "/data/kontexta", isDefaultDir: true };

describe("buildServerEntry", () => {
  it("npm: npx -y kontexta-mcp, no env on the OS default dir", () => {
    expect(buildServerEntry({ ...base, installMode: "npm" })).toEqual({ command: "npx", args: ["-y", "kontexta-mcp"] });
  });

  it("npm with a local kontexta install uses `kontexta mcp`", () => {
    expect(buildServerEntry({ ...base, installMode: "npm", hasLocalCliMcp: true }).args).toEqual(["-y", "kontexta", "mcp"]);
  });

  it("npm with a custom data dir, or forceEnv, sets KONTEXTA_DATA_DIR", () => {
    expect(buildServerEntry({ ...base, installMode: "npm", isDefaultDir: false }).env).toEqual({ KONTEXTA_DATA_DIR: "/data/kontexta" });
    expect(buildServerEntry({ ...base, installMode: "npm", forceEnv: true }).env).toEqual({ KONTEXTA_DATA_DIR: "/data/kontexta" });
  });

  it("docker mounts the host data dir; its env is inside the container, so none is set", () => {
    const e = buildServerEntry({ ...base, installMode: "docker", dataDir: "/app/data", hostDataDir: "/home/me/kx" });
    expect(e).toEqual({ command: "docker", args: ["run", "--rm", "-i", "-v", "/home/me/kx:/app/data", "safiyu/kontexta:5.1.0", "mcp"] });
  });

  it("docker without a host dir is an error", () => {
    expect(() => buildServerEntry({ ...base, installMode: "docker" })).toThrow(/host data/i);
  });

  it("source runs node on the entrypoint and requires it", () => {
    expect(buildServerEntry({ ...base, installMode: "source", sourceEntrypoint: "/src/apps/mcp/dist/index.js" })).toEqual({ command: "node", args: ["/src/apps/mcp/dist/index.js"] });
    expect(() => buildServerEntry({ ...base, installMode: "source" })).toThrow(/entrypoint/i);
  });

  describe("absolute commands for GUI-launched agents", () => {
    let bin: string;
    beforeEach(() => { bin = mkdtempSync(join(tmpdir(), "kontexta-bin-")); });
    afterEach(() => rmSync(bin, { recursive: true, force: true }));

    it("npm resolves npx next to the node binary when it exists", () => {
      const npx = join(bin, process.platform === "win32" ? "npx.cmd" : "npx");
      writeFileSync(npx, ""); chmodSync(npx, 0o755);
      expect(buildServerEntry({ ...base, installMode: "npm", absolute: true, nodeCmd: join(bin, "node") }).command).toBe(npx);
    });

    it("npm keeps bare npx when no sibling npx exists; source uses the absolute node", () => {
      expect(buildServerEntry({ ...base, installMode: "npm", absolute: true, nodeCmd: join(bin, "node") }).command).toBe("npx");
      expect(buildServerEntry({ ...base, installMode: "source", sourceEntrypoint: "/s/index.js", absolute: true, nodeCmd: "/opt/node" }).command).toBe("/opt/node");
    });
  });
});

describe("entrySignature", () => {
  const entry = { command: "npx", args: ["-y", "kontexta-mcp"] };
  it("is stable and changes with entry, approval or tool set", () => {
    const a = entrySignature(entry, "prompt", ["a"]);
    expect(entrySignature(entry, "prompt", ["a"])).toBe(a);
    expect(entrySignature({ ...entry, args: ["x"] }, "prompt", ["a"])).not.toBe(a);
    expect(entrySignature(entry, "all", ["a"])).not.toBe(a);
    expect(entrySignature(entry, "prompt", ["a", "b"])).toBe(a);
    expect(entrySignature(entry, "all", ["a", "b"])).not.toBe(entrySignature(entry, "all", ["a"]));
  });
});

describe("generated tool list", () => {
  it("has the kxta tools with destructive ones flagged", () => {
    const names = KXTA_TOOLS.map((t) => t.name);
    expect(names).toContain("files.create");
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["files.delete", "folders.delete", "files.restore", "admin.commit_backup"]) expect(KXTA_TOOLS.find((t) => t.name === n)?.destructive).toBe(true);
    expect(KXTA_TOOLS.find((t) => t.name === "files.read")?.destructive).toBe(false);
  });
});
