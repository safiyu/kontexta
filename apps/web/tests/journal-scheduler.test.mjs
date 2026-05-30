import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "kxta-core";
import { JournalScheduler } from "/tmp/kxta-test/journal-scheduler.js";

test("runMechanicalForAllProjects: empty projects table is a no-op", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-sched-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    const sched = new JournalScheduler({ baseDir: testDir });
    await sched.runMechanicalForAllProjects();
    // No throw = success
    assert.ok(true);
  } finally {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("runMechanicalForAllProjects: produces a distilled file for a project with raw events", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-sched-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();

    // Seed raw events
    const rawDir = join(testDir, "knowledge", "journal", "demo", "raw");
    mkdirSync(rawDir, { recursive: true });
    const rawFile = join(rawDir, "2026-05-12.jsonl");
    writeFileSync(rawFile,
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "claude-code", sid: "x", event: "tool_call", tool: "update_file", touched: ["a.ts"], status: "ok", ms: 10 }) + "\n" +
      JSON.stringify({ ts: "2026-05-12T10:01:00Z", agent: "claude-code", sid: "x", event: "error", touched: ["a.ts"], msg: "boom" }) + "\n"
    );
    // Backdate the raw file so isMcpActive returns false
    const old = new Date(0);
    utimesSync(rawFile, old, old);

    const sched = new JournalScheduler({ baseDir: testDir, presenceWindowSec: 30 });
    await sched.runMechanicalForAllProjects();

    // Look for any distilled markdown file
    const yearDirs = readdirSync(join(testDir, "knowledge", "journal", "demo")).filter((f) => /^\d{4}$/.test(f));
    assert.ok(yearDirs.length > 0, "expected distilled output dir");
  } finally {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("runMechanicalForAllProjects: defers when MCP is active (recent .jsonl)", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-sched-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();

    // Seed raw events with FRESH mtime so isMcpActive returns true
    const rawDir = join(testDir, "knowledge", "journal", "demo", "raw");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(
      join(rawDir, "2026-05-12.jsonl"),
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "claude-code", sid: "x", event: "tool_call", tool: "update_file", touched: ["a.ts"], status: "ok", ms: 10 }) + "\n",
    );
    // Don't backdate; mtime is now → isMcpActive returns true → scheduler defers

    const sched = new JournalScheduler({ baseDir: testDir, presenceWindowSec: 60 });
    await sched.runMechanicalForAllProjects();

    // No distilled output should exist (skipped due to active MCP)
    const projectDir = join(testDir, "knowledge", "journal", "demo");
    const yearDirs = readdirSync(projectDir).filter((f) => /^\d{4}$/.test(f));
    assert.strictEqual(yearDirs.length, 0, "expected NO distilled output (deferred)");
  } finally {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("runHousekeepForAllProjects: doesn't throw on empty project list", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-sched-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    const sched = new JournalScheduler({ baseDir: testDir });
    await sched.runHousekeepForAllProjects();
    assert.ok(true);
  } finally {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("start/stop: idempotent and clean", () => {
  const sched = new JournalScheduler({ baseDir: "/tmp", mechanicalEveryMs: 60_000, housekeepEveryMs: 60_000 });
  sched.start();
  sched.start(); // second start should be a no-op
  sched.stop();
  sched.stop(); // second stop should be a no-op
  assert.ok(true);
});
