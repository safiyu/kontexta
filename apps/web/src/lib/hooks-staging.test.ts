import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, getDatabase, resetDataDirCache } from "kxta-core";

describe("ensureHooksStaged", () => {
  let dataDir: string;
  const prev = process.env.KONTEXTA_DATA_DIR;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kx-web-hooks-")); process.env.KONTEXTA_DATA_DIR = dataDir; resetDataDirCache(); });
  afterEach(() => { closeDatabase(); (globalThis as any).__kontextaDb = undefined; process.env.KONTEXTA_DATA_DIR = prev; resetDataDirCache(); rmSync(dataDir, { recursive: true, force: true }); });

  it("seeds agents, stages the emitter and sidecar, and is idempotent", async () => {
    const { ensureDbInitialized, ensureHooksStaged } = await import("./db-init");
    ensureDbInitialized();
    ensureHooksStaged();
    expect(existsSync(join(dataDir, "hooks", "emit.mjs"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "hooks", "projects.json"), "utf8"))).toEqual({ version: 1, projects: [] });
    const n = getDatabase().prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number };
    expect(n.c).toBe(15);
    const before = readFileSync(join(dataDir, "hooks", "emit.mjs"), "utf8");
    ensureHooksStaged();
    expect(readFileSync(join(dataDir, "hooks", "emit.mjs"), "utf8")).toBe(before);
  });
});
