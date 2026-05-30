import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wrapHandler, initCapture, shutdownCapture } from "../dist/journal-capture.js";

test("writes a tool_call event when wrapped handler succeeds", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-cap-test-"));
  try {
    initCapture({ projectSlug: "demo", baseDir: testDir, agent: "claude-code", sid: "abc" });

    const wrapped = wrapHandler("search", async (args) => {
      return { content: [{ type: "text", text: "ok" }] };
    });
    const result = await wrapped({ query: "x" });
    assert.strictEqual(result.content[0].text, "ok");

    const dir = join(testDir, "demo", "raw");
    const files = readdirSync(dir);
    assert.strictEqual(files.length, 1);

    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 1);

    const ev = JSON.parse(lines[0]);
    assert.strictEqual(ev.tool, "search");
    assert.strictEqual(ev.status, "ok");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("captures errors but still returns the original error result", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-cap-test-"));
  try {
    initCapture({ projectSlug: "demo", baseDir: testDir, agent: "claude-code", sid: "abc" });

    const wrapped = wrapHandler("update_file", async () => {
      return { isError: true, content: [{ type: "text", text: '{"error":"boom"}' }] };
    });
    const result = await wrapped({ id: 1 });
    assert.strictEqual(result.isError, true);

    const dir = join(testDir, "demo", "raw");
    const lines = readFileSync(join(dir, readdirSync(dir)[0]), "utf8").trim().split("\n");
    const ev = JSON.parse(lines[0]);
    assert.strictEqual(ev.status, "error");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("does not propagate journal write failures (capture errors swallowed)", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-cap-test-"));
  try {
    initCapture({ projectSlug: "demo", baseDir: testDir, agent: "claude-code", sid: "abc" });
    shutdownCapture(); // simulate writer not initialised

    const wrapped = wrapHandler("search", async () => ({ content: [{ type: "text", text: "ok" }] }));
    // Should still return result, not throw
    const result = await wrapped({ query: "x" });
    assert.strictEqual(result.content[0].text, "ok");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
