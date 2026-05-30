import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initCapture,
  shutdownCapture,
  setDataDir,
  getBacklogStatus,
} from "../dist/journal-capture.js";

test("getBacklogStatus counts events from raw .jsonl", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-backlog-test-"));
  try {
    setDataDir(testDir);
    initCapture({
      projectSlug: "demo",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "abc",
    });
    const rawDir = join(testDir, "knowledge", "journal", "demo", "raw");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "2026-05-12.jsonl"),
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "x", sid: "x", event: "tool_call", tool: "search" }) + "\n" +
      JSON.stringify({ ts: "2026-05-12T10:01:00Z", agent: "x", sid: "x", event: "tool_call", tool: "search" }) + "\n"
    );
    const status = getBacklogStatus("demo");
    assert.equal(status.backlog_events, 2);
    assert.equal(status.high_water, null);
    assert.ok(typeof status.backlog_oldest_age_hours === "number");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("getBacklogStatus returns 0 when raw dir missing", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-backlog-test-"));
  try {
    setDataDir(testDir);
    initCapture({
      projectSlug: "demo",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "abc",
    });
    const status = getBacklogStatus("demo");
    assert.equal(status.backlog_events, 0);
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});
