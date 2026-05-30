import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase, distillJournal } from "kxta-core";
import {
  initCapture,
  shutdownCapture,
  setDataDir,
  wrapHandler,
  appendVoluntaryEvent,
} from "../dist/journal-capture.js";

test("journal end-to-end: capture → distill → markdown + DB index", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-journal-e2e-"));
  try {
    // 0. DB + project
    createDatabase(join(testDir, "kontexta.db"));
    const db = getDatabase();
    db.prepare(
      `INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`,
    ).run();

    // 1. Init capture
    setDataDir(testDir);
    initCapture({
      projectSlug: "demo",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "e2e",
    });

    // 2. Simulate wrapped tool calls
    const okTool = wrapHandler("update_file", async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    await okTool({ path: "src/websocket.ts" });
    await okTool({ path: "src/websocket.ts" });

    // 3. Capture an error event
    const failingTool = wrapHandler("update_file", async () => ({
      isError: true,
      content: [{ type: "text", text: '{"error":"section heading not found"}' }],
    }));
    await failingTool({ path: "src/websocket.ts" });

    // 4. Voluntary agent_note
    appendVoluntaryEvent({
      ts: new Date().toISOString(),
      agent: "claude-code",
      sid: "e2e",
      event: "agent_note",
      summary: "tried debouncing first; abandoned",
      tags: ["abandoned"],
    });

    // 5. Distill
    const result = await distillJournal({
      projectSlug: "demo",
      projectId: 1,
      dataDir: testDir,
      maxEvents: 200,
      ticketRegex: /[A-Z]+-\d+/,
      openTaskWindowDays: 90,
      inFlightWindowSeconds: 0, // skip in-flight buffer for the test
      now: new Date(Date.now() + 60_000), // 1 minute ahead so all events are processed
    });

    assert.ok(result.events_processed >= 4, `expected ≥4 events processed, got ${result.events_processed}`);
    assert.ok(result.tasks_created.length > 0, "expected ≥1 task created");

    // 6. Markdown exists under YYYY/MM/DD/
    const root = join(testDir, "knowledge", "journal", "demo");
    const yearDirs = readdirSync(root).filter((f) => /^\d{4}$/.test(f));
    assert.ok(yearDirs.length > 0, "expected at least one YYYY/ directory under demo/");

    // 7. DB row exists
    const meta = db.prepare(`SELECT COUNT(*) AS c FROM journal_meta`).get();
    assert.ok(meta.c > 0, `expected journal_meta rows, got ${meta.c}`);
  } finally {
    shutdownCapture();
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});
