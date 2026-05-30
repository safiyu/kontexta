// packages/core/tests/journal/distill.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { distillJournal } from "../../src/journal/distill.js";

describe("distillJournal — integration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-distill-test-"));
    createDatabase(join(testDir, "test.db"));
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeRaw(day: string, lines: string[]) {
    const dir = join(testDir, "knowledge", "journal", "demo", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${day}.jsonl`), lines.map((l) => l + "\n").join(""));
  }

  it("reads raw events, writes distilled markdown, advances high-water", async () => {
    writeRaw("2026-05-12", [
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "update_file", args: {}, touched: ["a.ts"], status: "ok", ms: 10 }),
      JSON.stringify({ ts: "2026-05-12T10:01:00Z", agent: "claude-code", sid: "s", event: "error", touched: ["a.ts"], msg: "boom" }),
      JSON.stringify({ ts: "2026-05-12T10:02:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "update_file", args: {}, touched: ["a.ts"], status: "ok", ms: 10 }),
    ]);

    const result = await distillJournal({
      projectSlug: "demo",
      projectId: 1,
      dataDir: testDir,
      maxEvents: 200,
      ticketRegex: /[A-Z]+-\d+/,
      openTaskWindowDays: 90,
      inFlightWindowSeconds: 0, // no buffer for test
      now: new Date("2026-05-12T11:00:00Z"),
    });

    expect(result.events_processed).toBe(3);
    expect(result.tasks_touched.length).toBeGreaterThan(0);

    const distilledRoot = join(testDir, "knowledge", "journal", "demo", "2026", "05", "12");
    const distilledFiles = readdirSync(distilledRoot);
    expect(distilledFiles.length).toBeGreaterThan(0);
    const body = readFileSync(join(distilledRoot, distilledFiles[0]), "utf8");
    expect(body).toMatch(/error-recovery/);

    // High water advanced
    const hwPath = join(testDir, "knowledge", "journal", "demo", ".distilled-up-to.json");
    expect(existsSync(hwPath)).toBe(true);
    const hw = JSON.parse(readFileSync(hwPath, "utf8"));
    expect(hw.events_processed).toBe(3);
  });

  it("is idempotent — second run with no new events does nothing", async () => {
    writeRaw("2026-05-12", [
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "update_file", args: {}, touched: ["a.ts"], status: "ok", ms: 10 }),
    ]);
    const opts = {
      projectSlug: "demo", projectId: 1, dataDir: testDir, maxEvents: 200,
      ticketRegex: /[A-Z]+-\d+/, openTaskWindowDays: 90, inFlightWindowSeconds: 0,
      now: new Date("2026-05-12T11:00:00Z"),
    };
    await distillJournal(opts);
    const second = await distillJournal(opts);
    expect(second.events_processed).toBe(0);
  });
});
