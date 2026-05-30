// apps/web/tests/journal-scheduler-e2e.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "kxta-core";
import { JournalScheduler } from "/tmp/kxta-test/journal-scheduler.js";

test("scheduler E2E: events → tick → markdown + journal_meta row", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-sched-e2e-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();

    // Seed raw events
    const rawDir = join(testDir, "knowledge", "journal", "demo", "raw");
    mkdirSync(rawDir, { recursive: true });
    const rawFile = join(rawDir, "2026-05-12.jsonl");
    writeFileSync(rawFile,
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "claude-code", sid: "x", event: "tool_call", tool: "update_file", touched: ["src/websocket.ts"], status: "ok", ms: 10 }) + "\n" +
      JSON.stringify({ ts: "2026-05-12T10:01:00Z", agent: "claude-code", sid: "x", event: "error", touched: ["src/websocket.ts"], msg: "boom" }) + "\n" +
      JSON.stringify({ ts: "2026-05-12T10:02:00Z", agent: "claude-code", sid: "x", event: "tool_call", tool: "update_file", touched: ["src/websocket.ts"], status: "ok", ms: 10 }) + "\n"
    );
    // Backdate so isMcpActive returns false
    const old = new Date(0);
    utimesSync(rawFile, old, old);

    const sched = new JournalScheduler({ baseDir: testDir, presenceWindowSec: 30 });

    await sched.runMechanicalForAllProjects();

    // 1. Markdown file produced
    const projectRoot = join(testDir, "knowledge", "journal", "demo");
    const yearDirs = readdirSync(projectRoot).filter((f) => /^\d{4}$/.test(f));
    assert.ok(yearDirs.length > 0, "expected at least one YYYY/ directory");

    // 2. journal_meta row populated
    const metaCount = db.prepare(`SELECT COUNT(*) AS c FROM journal_meta`).get();
    assert.ok(metaCount.c > 0, `expected journal_meta rows, got ${metaCount.c}`);

    // 3. high_water advanced (DB doesn't track it, the file does — check the file)
    const hwPath = join(testDir, "knowledge", "journal", "demo", ".distilled-up-to.json");
    assert.ok(existsSync(hwPath), "expected high-water file to exist");
  } finally {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});
