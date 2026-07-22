// apps/mcp/tests/journal-envelope-threshold.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initCapture,
  shutdownCapture,
  setDataDir,
  wrapHandler,
} from "../dist/journal-capture.js";

function seedRawEvents(testDir, slug, count, ageHours) {
  const dir = join(testDir, "knowledge", "journal", slug, "raw");
  mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  const lines = Array.from({ length: count }, () =>
    JSON.stringify({ ts, agent: "claude-code", sid: "s", event: "tool_call", tool: "search", status: "ok", ms: 5 }),
  ).join("\n") + "\n";
  writeFileSync(join(dir, "2026-07-22.jsonl"), lines);
}

async function callWrapped() {
  const handler = wrapHandler("noop_tool", async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
  }));
  const result = await handler({});
  return JSON.parse(result.content[0].text);
}

test("envelope is NOT injected below the nudge thresholds", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 10, 0.1); // 10 events, 6 minutes old
    const body = await callWrapped();
    assert.equal(body.journal, undefined, "expected no journal envelope below thresholds");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("envelope IS injected once backlog_events crosses the event threshold", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 51, 0.1); // 51 events, still recent
    const body = await callWrapped();
    assert.ok(body.journal, "expected a journal envelope");
    assert.equal(body.journal.suggested_action, "distill_journal");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("envelope is NOT injected at exactly 49 events (just below the event threshold)", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 48, 0.1); // seed 48; tool_call adds 1 → 49 total
    const body = await callWrapped();
    assert.equal(body.journal, undefined, "expected no journal envelope at 49 events (below the 50-event threshold)");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("envelope IS injected at exactly 50 events (the event threshold)", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 49, 0.1); // seed 49; tool_call adds 1 → 50 total
    const body = await callWrapped();
    assert.ok(body.journal, "expected a journal envelope at exactly 50 events (the >= 50 threshold)");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("envelope IS injected once the oldest event crosses the age threshold", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 1, 1.01); // 1 event, 1.01 hours old (just over the 1-hour threshold)
    const body = await callWrapped();
    assert.ok(body.journal, "expected a journal envelope");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});
