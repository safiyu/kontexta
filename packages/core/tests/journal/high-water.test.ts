import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHighWater, writeHighWater } from "../../src/journal/high-water.js";

describe("high-water", () => {
  let testDir: string;
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), "kontexta-hw-test-")); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("returns null when the file does not exist", () => {
    expect(readHighWater(testDir, "p1")).toBeNull();
  });

  it("writes and reads back the high-water mark", () => {
    writeHighWater(testDir, "p1", {
      last_event_ts: "2026-05-12T16:00:00Z",
      last_distilled_at: "2026-05-12T16:05:00Z",
      events_processed: 47,
    });
    const read = readHighWater(testDir, "p1");
    expect(read?.last_event_ts).toBe("2026-05-12T16:00:00Z");
    expect(read?.events_processed).toBe(47);
  });

  it("writes atomically (no .tmp file remains on success)", () => {
    writeHighWater(testDir, "p1", {
      last_event_ts: "2026-05-12T16:00:00Z",
      last_distilled_at: "2026-05-12T16:05:00Z",
      events_processed: 1,
    });
    const tmpPath = join(testDir, "p1", ".distilled-up-to.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("returns null on malformed JSON (logged warning, doesn't throw)", () => {
    const dir = join(testDir, "p1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".distilled-up-to.json"), "{ not json");
    expect(readHighWater(testDir, "p1")).toBeNull();
  });
});
