import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initCapture,
  shutdownCapture,
  setDataDir,
  appendVoluntaryEvent,
} from "../dist/journal-capture.js";

test("appendVoluntaryEvent writes an agent_note event", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-jtools-test-"));
  try {
    setDataDir(testDir);
    initCapture({
      projectSlug: "demo",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "abc",
    });
    appendVoluntaryEvent({
      ts: new Date().toISOString(),
      agent: "claude-code",
      sid: "abc",
      event: "agent_note",
      summary: "decided to use FTS5",
      tags: ["decision"],
    });
    const dir = join(testDir, "knowledge", "journal", "demo", "raw");
    const lines = readFileSync(join(dir, readdirSync(dir)[0]), "utf8").trim().split("\n");
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, "agent_note");
    assert.equal(ev.summary, "decided to use FTS5");
    assert.deepEqual(ev.tags, ["decision"]);
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});
