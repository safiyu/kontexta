import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveManualEntrypoint, resolveManualEntrypointFrom } from "./manual-entrypoint";

describe("resolveManualEntrypoint", () => {
  let root: string; let start: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kx-entry-")); start = join(root, "apps", "web", "src", "lib"); mkdirSync(start, { recursive: true }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const built = () => { mkdirSync(join(root, "apps", "mcp", "dist"), { recursive: true }); writeFileSync(join(root, "apps", "mcp", "dist", "index.js"), ""); return join(root, "apps", "mcp", "dist", "index.js"); };

  it("finds the built MCP server in a checkout that was never bootstrapped", () => {
    expect(resolveManualEntrypoint(start)).toBeNull();
    expect(resolveManualEntrypoint(start)).toBeNull();
    const entry = built();
    expect(resolveManualEntrypoint(start)).toBe(entry);
  });

  it("prefers the bootstrap marker when there is one", () => {
    built();
    mkdirSync(join(root, "custom"), { recursive: true });
    writeFileSync(join(root, "custom", "server.js"), "");
    writeFileSync(join(root, ".kontexta-manual-mcp"), "custom/server.js\n");
    expect(resolveManualEntrypoint(start)).toBe(join(root, "custom", "server.js"));
  });

  it("does not follow a marker that points outside its own tree", () => {
    writeFileSync(join(root, ".kontexta-manual-mcp"), "../../etc/passwd\n");
    expect(resolveManualEntrypoint(start)).toBeNull();
  });

  it("still finds the checkout when the module path is not a real directory (Turbopack dev reports a virtual import.meta.url)", () => {
    const entry = built();
    expect(resolveManualEntrypointFrom(["/[project]/apps/web/src/lib", join(root, "apps", "web")])).toBe(entry);
    expect(resolveManualEntrypointFrom(["/[project]/apps/web/src/lib"])).toBeNull();
  });

  it("an explicit KONTEXTA_MCP_ENTRYPOINT wins when the file exists", () => {
    built();
    const custom = join(root, "custom.js");
    writeFileSync(custom, "");
    process.env.KONTEXTA_MCP_ENTRYPOINT = custom;
    try { expect(resolveManualEntrypointFrom([start])).toBe(custom); } finally { delete process.env.KONTEXTA_MCP_ENTRYPOINT; }
    process.env.KONTEXTA_MCP_ENTRYPOINT = join(root, "missing.js");
    try { expect(resolveManualEntrypointFrom([start])).toBe(join(root, "apps", "mcp", "dist", "index.js")); } finally { delete process.env.KONTEXTA_MCP_ENTRYPOINT; }
  });
});
