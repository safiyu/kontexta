import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JournalWriter } from "../../src/journal/writer.js";
import type { RawEvent } from "../../src/journal/types.js";

describe("JournalWriter", () => {
  let testDir: string;
  let writer: JournalWriter;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-writer-test-"));
  });

  afterEach(() => {
    writer?.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function ev(overrides: Partial<RawEvent> = {}): RawEvent {
    return {
      ts: new Date().toISOString(),
      agent: "claude-code",
      sid: "test-sid",
      event: "tool_call",
      tool: "search",
      args: { query: "x" },
      touched: [],
      status: "ok",
      ms: 12,
      ...overrides,
    };
  }

  it("creates the per-day .jsonl file on first append", () => {
    writer = new JournalWriter({ projectSlug: "p1", baseDir: testDir });
    writer.append(ev({ ts: "2026-05-12T16:03:21.000Z" }));
    const expected = join(testDir, "p1", "raw", "2026-05-12.jsonl");
    expect(existsSync(expected)).toBe(true);
    const lines = readFileSync(expected, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).tool).toBe("search");
  });

  it("appends multiple events as separate lines", () => {
    writer = new JournalWriter({ projectSlug: "p1", baseDir: testDir });
    writer.append(ev({ ts: "2026-05-12T16:03:21.000Z" }));
    writer.append(ev({ ts: "2026-05-12T16:03:22.000Z", tool: "read_file" }));
    const lines = readFileSync(
      join(testDir, "p1", "raw", "2026-05-12.jsonl"),
      "utf8",
    ).trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("rotates to a new file when the day changes", () => {
    writer = new JournalWriter({ projectSlug: "p1", baseDir: testDir });
    writer.append(ev({ ts: "2026-05-12T23:59:59.000Z" }));
    writer.append(ev({ ts: "2026-05-13T00:00:01.000Z" }));
    expect(existsSync(join(testDir, "p1", "raw", "2026-05-12.jsonl"))).toBe(true);
    expect(existsSync(join(testDir, "p1", "raw", "2026-05-13.jsonl"))).toBe(true);
  });

  it("creates parent directories if missing", () => {
    writer = new JournalWriter({ projectSlug: "deep/nested", baseDir: testDir });
    writer.append(ev());
    expect(existsSync(join(testDir, "deep/nested", "raw"))).toBe(true);
  });
});
