import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveManualEntrypoint } from "./manual-entrypoint";

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
});
