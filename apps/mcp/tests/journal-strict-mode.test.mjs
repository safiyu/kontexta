// apps/mcp/tests/journal-strict-mode.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initCapture, shutdownCapture, setDataDir, wrapHandler } from "../dist/journal-capture.js";

function setup() {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-strict-"));
  setDataDir(testDir);
  initCapture({
    projectSlug: "demo",
    baseDir: join(testDir, "knowledge", "journal"),
    agent: "claude-code",
    sid: "x",
  });
  // Write a kontexta.json with strict mode
  writeFileSync(join(testDir, "kontexta.json"), JSON.stringify({ version: "1", journal: { mode: "strict" } }));
  // Seed a raw event so backlog > 0
  const rawDir = join(testDir, "knowledge", "journal", "demo", "raw");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(
    join(rawDir, "2026-05-12.jsonl"),
    JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "x", sid: "x", event: "tool_call", tool: "search" }) + "\n",
  );
  return testDir;
}

function teardown(testDir) {
  shutdownCapture();
  rmSync(testDir, { recursive: true, force: true });
}

test("strict mode: blocks a read tool with JOURNAL_BACKLOG error", async () => {
  const testDir = setup();
  try {
    const wrapped = wrapHandler("search", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const result = await wrapped({ query: "x" });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.code, "JOURNAL_BACKLOG");
  } finally {
    teardown(testDir);
  }
});

test("strict mode: allows a write tool through", async () => {
  const testDir = setup();
  try {
    const wrapped = wrapHandler("update_file", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const result = await wrapped({ path: "x.md" });
    assert.equal(result.isError, undefined);
  } finally {
    teardown(testDir);
  }
});

test("strict mode: allows a read tool when bypass is set", async () => {
  const testDir = setup();
  try {
    const wrapped = wrapHandler("search", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const result = await wrapped({ query: "x", journal_bypass: true });
    assert.equal(result.isError, undefined);
  } finally {
    teardown(testDir);
  }
});
