import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "kxta-core";
import { wrapHandler, initCapture, shutdownCapture, setDataDir, appendVoluntaryEvent } from "../dist/journal-capture.js";

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

function lastEvent(testDir) {
  const dir = join(testDir, "demo", "raw");
  const lines = readFileSync(join(dir, readdirSync(dir)[0]), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("resolves id / ids / file_id args to on-disk paths in touched", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-cap-test-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    const db = getDatabase();
    const ins = db.prepare(`INSERT INTO files (path, title, storage_type) VALUES (?, ?, 'local')`);
    const a = Number(ins.run("/kb/a.md", "a").lastInsertRowid);
    const b = Number(ins.run("/kb/b.md", "b").lastInsertRowid);
    const c = Number(ins.run("/kb/c.md", "c").lastInsertRowid);
    initCapture({ projectSlug: "demo", baseDir: testDir, agent: "claude-code", sid: "abc" });
    const ok = async () => ({ content: [{ type: "text", text: "{}" }] });

    await wrapHandler("files_update", ok)({ id: a, content: "x" });
    assert.deepStrictEqual(lastEvent(testDir).touched, ["/kb/a.md"]);

    await wrapHandler("files_delete", async (args) => {
      db.prepare(`DELETE FROM files WHERE id IN (${args.ids.join(",")})`).run();
      return ok();
    })({ ids: [b, c] });
    assert.deepStrictEqual(lastEvent(testDir).touched.sort(), ["/kb/b.md", "/kb/c.md"]);

    await wrapHandler("files_get_history", ok)({ file_id: a });
    assert.deepStrictEqual(lastEvent(testDir).touched, ["/kb/a.md"]);
  } finally {
    shutdownCapture();
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("records created[].path from a files_create result in touched", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-cap-test-"));
  try {
    initCapture({ projectSlug: "demo", baseDir: testDir, agent: "claude-code", sid: "abc" });
    const wrapped = wrapHandler("files_create", async () => ({
      content: [{ type: "text", text: JSON.stringify({ created_count: 2, created: [{ id: 1, path: "/kb/new1.md" }, { id: 2, path: "/kb/new2.mmd" }], errors: [] }) }],
    }));
    await wrapped({ files: [{ title: "new1", content: "x", destination: "knowledge", kind: "note" }, { title: "new2", content: "y", destination: "knowledge", format: "mmd" }] });
    assert.deepStrictEqual(lastEvent(testDir).touched, ["/kb/new1.md", "/kb/new2.mmd"]);
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("leaves touched empty when the id is unknown", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-cap-test-"));
  try {
    setDataDir(testDir);
    createDatabase(join(testDir, "kontexta.db"));
    initCapture({ projectSlug: "demo", baseDir: testDir, agent: "claude-code", sid: "abc" });
    const wrapped = wrapHandler("files_update", async () => ({ content: [{ type: "text", text: "{}" }] }));
    await wrapped({ id: 999999, content: "x" });
    assert.deepStrictEqual(lastEvent(testDir).touched, []);
  } finally {
    shutdownCapture();
    closeDatabase();
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

test("stamps source:'mcp' on tool_call, error and voluntary events", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-cap-test-"));
  try {
    initCapture({ projectSlug: "demo", baseDir: testDir, agent: "claude-code", sid: "abc" });
    await wrapHandler("search", async () => ({ content: [{ type: "text", text: "ok" }] }))({ query: "x" });
    assert.strictEqual(lastEvent(testDir).source, "mcp");
    await assert.rejects(wrapHandler("files_update", async () => { throw new Error("boom"); })({ id: 1 }));
    assert.strictEqual(lastEvent(testDir).source, "mcp");
    appendVoluntaryEvent({ ts: new Date().toISOString(), agent: "claude-code", sid: "abc", event: "agent_note", summary: "n" });
    assert.strictEqual(lastEvent(testDir).source, "mcp");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});
