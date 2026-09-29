import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import {
  EMITTER_VERSION, emitterVersionOf, emitterSourcePath, emitterSourceCandidates, stagedEmitterPath, stageEmitter, emitterVersionOnDisk, syncProjectsSidecar, syncProjectsSidecarIfStaged, pruneHookState,
} from "../../src/hooks/stage.js";

describe("hooks staging", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kontexta-stage-")); createDatabase(join(dataDir, "t.db")); });
  afterEach(() => { closeDatabase(); rmSync(dataDir, { recursive: true, force: true }); });

  it("EMITTER_VERSION is a content hash of emit.mjs, so any emitter change changes it", () => {
    const src = readFileSync(emitterSourcePath(), "utf8");
    expect(EMITTER_VERSION).toBe(emitterVersionOf(src));
    expect(EMITTER_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(emitterVersionOf(src + "\n// changed")).not.toBe(EMITTER_VERSION);
  });

  it("stages emit.mjs with the version stamped on line 1 and reports changed only when content differs", () => {
    const first = stageEmitter(dataDir);
    expect(first.changed).toBe(true);
    expect(first.path).toBe(stagedEmitterPath(dataDir));
    const text = readFileSync(first.path, "utf8");
    expect(text.split(/\r?\n/)[0]).toBe(`// kontexta-hooks v${EMITTER_VERSION}`);
    expect(text).toContain("export const ADAPTERS");
    expect(readFileSync(emitterSourcePath(), "utf8").split(/\r?\n/)[0]).toBe("// kontexta-hooks v0.0.0-dev");
    expect(emitterVersionOnDisk(dataDir)).toBe(EMITTER_VERSION);
    expect(stageEmitter(dataDir).changed).toBe(false);
  });

  it("emitterVersionOnDisk is null when nothing is staged or the header is foreign", () => {
    expect(emitterVersionOnDisk(dataDir)).toBeNull();
    mkdirSync(join(dataDir, "hooks"), { recursive: true });
    writeFileSync(stagedEmitterPath(dataDir), "// something else\n");
    expect(emitterVersionOnDisk(dataDir)).toBeNull();
  });

  it("syncProjectsSidecar writes registered projects with a path and skips synthetic rows", () => {
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (name, slug, path) VALUES ('Demo', 'demo', '/tmp/demo')`).run();
    db.prepare(`INSERT INTO projects (name, slug, path) VALUES ('Orphan', 'default', NULL)`).run();
    const r = syncProjectsSidecar(dataDir);
    expect(r.count).toBe(1);
    const sidecar = JSON.parse(readFileSync(join(dataDir, "hooks", "projects.json"), "utf8"));
    expect(sidecar).toEqual({ version: 1, projects: [{ slug: "demo", path: "/tmp/demo" }] });
  });

  it("pruneHookState removes state files older than maxAgeDays only", () => {
    const stateDir = join(dataDir, "hooks", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "old.json"), "{}");
    writeFileSync(join(stateDir, "new.json"), "{}");
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(stateDir, "old.json"), old, old);
    expect(pruneHookState(dataDir, 30)).toBe(1);
    expect(existsSync(join(stateDir, "old.json"))).toBe(false);
    expect(existsSync(join(stateDir, "new.json"))).toBe(true);
    expect(pruneHookState(join(dataDir, "nope"), 30)).toBe(0);
  });

  it("syncProjectsSidecarIfStaged never writes under test, so registering projects can't touch a real data dir", () => {
    mkdirSync(join(dataDir, "hooks"), { recursive: true });
    getDatabase().prepare(`INSERT INTO projects (name, slug, path) VALUES ('Demo', 'demo', '/tmp/demo')`).run();
    syncProjectsSidecarIfStaged(dataDir);
    expect(existsSync(join(dataDir, "hooks", "projects.json"))).toBe(false);
  });

  it("syncProjectsSidecarIfStaged writes once staged (outside test env) and skips unstaged dirs", () => {
    const saved = { v: process.env.VITEST, n: process.env.NODE_ENV };
    delete process.env.VITEST; process.env.NODE_ENV = "production";
    try {
      getDatabase().prepare(`INSERT INTO projects (name, slug, path) VALUES ('Demo', 'demo', '/tmp/demo')`).run();
      syncProjectsSidecarIfStaged(dataDir);
      expect(existsSync(join(dataDir, "hooks"))).toBe(false);
      mkdirSync(join(dataDir, "hooks"), { recursive: true });
      syncProjectsSidecarIfStaged(dataDir);
      expect(JSON.parse(readFileSync(join(dataDir, "hooks", "projects.json"), "utf8")).projects).toEqual([{ slug: "demo", path: "/tmp/demo" }]);
    } finally {
      if (saved.v !== undefined) process.env.VITEST = saved.v;
      if (saved.n !== undefined) process.env.NODE_ENV = saved.n; else delete process.env.NODE_ENV;
    }
  });

  it("emitterSourceCandidates finds the copy shipped inside node_modules/kxta-core when bundles relocate import.meta.url", () => {
    const root = mkdtempSync(join(tmpdir(), "kontexta-bundle-"));
    try {
      const shipped = join(root, "node_modules", "kxta-core", "dist", "hooks", "emit.mjs");
      mkdirSync(join(root, "node_modules", "kxta-core", "dist", "hooks"), { recursive: true });
      writeFileSync(shipped, "// kontexta-hooks v0.0.0-dev\n");
      const here = join(root, "standalone", "apps", "web", ".next", "server", "chunks");
      expect(emitterSourceCandidates(here, "/nonexistent")).toContain(shipped);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
