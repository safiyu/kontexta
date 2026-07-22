// apps/mcp/tests/journal-engine.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase, startDistillEngine, registerProject } from "kxta-core";
import {
  initCapture,
  shutdownCapture,
  setDataDir,
  wrapHandler,
} from "../dist/journal-capture.js";

test("distillation engine drains an orphan slug's backlog end-to-end", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-e2e-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    setDataDir(testDir);
    // No project row for "default" — this is the orphan-slug scenario.
    initCapture({
      projectSlug: "default",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "eng-e2e",
    });

    const okTool = wrapHandler("update_file", async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    await okTool({ path: "notes.md" });
    await okTool({ path: "notes.md" });

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date(Date.now() + 6 * 60_000), // 6 min ahead of the events just written
    });

    let tickResult;
    try {
      tickResult = await engine.tickNow();
    } finally {
      await engine.stop();
    }

    assert.ok(tickResult.slugs_distilled >= 1, `expected ≥1 slug distilled, got ${JSON.stringify(tickResult)}`);

    const db = getDatabase();
    const project = db.prepare("SELECT * FROM projects WHERE slug = ?").get("default");
    assert.ok(project, "expected an auto-provisioned project row for 'default'");
    assert.equal(project.path, null, "synthetic project should have path=NULL");

    const distilledRoot = join(testDir, "knowledge", "journal", "default");
    const yearDirs = readdirSync(distilledRoot).filter((f) => /^\d{4}$/.test(f));
    assert.ok(yearDirs.length > 0, "expected at least one YYYY/ directory");

    // Promote the synthetic project to a real one; distilled entries must
    // stay linked to the same project_id (no orphaned journal_meta rows).
    const promoted = registerProject("Default", join(testDir, "real-project-path"));
    assert.equal(promoted.id, project.id, "promotion should keep the same project id");
    assert.equal(promoted.path, join(testDir, "real-project-path"));

    const metaCount = db.prepare("SELECT COUNT(*) AS c FROM journal_meta WHERE project_id = ?").get(project.id);
    assert.ok(metaCount.c > 0, "expected journal_meta rows still linked to the promoted project");
  } finally {
    shutdownCapture();
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("engine uses an already-registered project directly (no synthetic duplicate)", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-registered-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    setDataDir(testDir);

    const registered = registerProject("Scratch", join(testDir, "scratch-project"));
    assert.equal(registered.slug, "scratch");

    initCapture({
      projectSlug: "scratch",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "eng-registered",
    });

    const okTool = wrapHandler("update_file", async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    await okTool({ path: "notes.md" });

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date(Date.now() + 6 * 60_000),
    });
    try {
      const tickResult = await engine.tickNow();
      assert.ok(tickResult.slugs_distilled >= 1, `expected ≥1 slug distilled, got ${JSON.stringify(tickResult)}`);
    } finally {
      await engine.stop();
    }

    const db = getDatabase();
    const rows = db.prepare("SELECT * FROM projects WHERE slug = ?").all("scratch");
    assert.equal(rows.length, 1, "expected exactly one project row for slug 'scratch', no synthetic duplicate");
    assert.equal(rows[0].id, registered.id, "distillation should reuse the registered project id");
    assert.equal(rows[0].path, join(testDir, "scratch-project"), "registered path must be untouched");

    const distilledRoot = join(testDir, "knowledge", "journal", "scratch");
    const yearDirs = readdirSync(distilledRoot).filter((f) => /^\d{4}$/.test(f));
    assert.ok(yearDirs.length > 0, "expected distilled entries under the registered slug");
  } finally {
    shutdownCapture();
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});
