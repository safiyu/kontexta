import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { createFile, updateFile } from "../src/files/index.js";
import { addTags } from "../src/metadata/index.js";
import { whatsNew, resolveSince } from "../src/whats-new/index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kontexta-wn-"));
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  createDatabase(join(dataDir, "test.db"));
});
afterEach(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Force a file's timestamps to a specific UTC datetime ("YYYY-MM-DD HH:MM:SS"). */
function setTimestamps(id: number, created: string, updated: string) {
  getDatabase()
    .prepare("UPDATE files SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(created, updated, id);
}

describe("resolveSince", () => {
  const NOW = new Date("2026-04-30T12:00:00Z");

  it("parses ISO 8601 timestamp", () => {
    expect(resolveSince("2026-04-30T11:30:00Z", NOW)).toBe("2026-04-30 11:30:00");
  });

  it.each([
    ["30s", "2026-04-30 11:59:30"],
    ["15m", "2026-04-30 11:45:00"],
    ["2h",  "2026-04-30 10:00:00"],
    ["1d",  "2026-04-29 12:00:00"],
    ["7d",  "2026-04-23 12:00:00"],
    ["1w",  "2026-04-23 12:00:00"],
  ])("parses relative duration %s", (since, expected) => {
    expect(resolveSince(since, NOW)).toBe(expected);
  });

  it("throws RangeError on garbage input", () => {
    expect(() => resolveSince("yesterday", NOW)).toThrow(RangeError);
  });

  it("throws RangeError on empty input", () => {
    expect(() => resolveSince("", NOW)).toThrow(RangeError);
  });

  it("throws RangeError when `since` is in the future", () => {
    expect(() => resolveSince("2026-05-01T00:00:00Z", NOW)).toThrow(/future/);
  });
});

describe("whatsNew", () => {
  it("returns empty result when no files exist", () => {
    const r = whatsNew({ since: "1h" });
    expect(r.count).toBe(0);
    expect(r.files).toEqual([]);
    expect(r.until).toBeTruthy();
  });

  it("flags files with created_at >= since as 'created', others as 'modified'", async () => {
    const old = await createFile({ title: "Old", content: "old body", destination: "knowledge", dataDir });
    const fresh = await createFile({ title: "Fresh", content: "new body", destination: "knowledge", dataDir });

    // Backdate `old` to 2 days ago for both timestamps; touch its updated_at to "now-ish"
    // so it shows up as 'modified' in the window. `fresh` stays at default (now).
    setTimestamps(old.id, "2026-04-28 12:00:00", "2026-04-30 11:59:00");
    // Force `fresh` created_at into the window so it reads as 'created'.
    setTimestamps(fresh.id, "2026-04-30 11:59:30", "2026-04-30 11:59:30");

    const r = whatsNew({ since: "2026-04-30T11:00:00Z" });
    const byTitle = Object.fromEntries(r.files.map((f) => [f.title, f]));
    expect(byTitle.Fresh.change).toBe("created");
    expect(byTitle.Old.change).toBe("modified");
  });

  it("excludes files whose updated_at is older than since", async () => {
    const stale = await createFile({ title: "Stale", content: "x".repeat(50), destination: "knowledge", dataDir });
    setTimestamps(stale.id, "2026-01-01 00:00:00", "2026-01-01 00:00:00");
    const r = whatsNew({ since: "2026-04-01T00:00:00Z" });
    expect(r.files.find((f) => f.id === stale.id)).toBeUndefined();
  });

  it("filters by project_id when provided", async () => {
    const kb = await createFile({ title: "K", content: "k", destination: "knowledge", dataDir });
    void kb;
    const r = whatsNew({ since: "1h", project_id: null });
    expect(r.files.every((f) => f.project_id === null)).toBe(true);
  });

  it("attaches tags[] when include_tags is true (default)", async () => {
    const f = await createFile({ title: "Tagged", content: "body", destination: "knowledge", dataDir, tags: ["alpha", "beta"] });
    void f;
    const r = whatsNew({ since: "1h" });
    const entry = r.files.find((x) => x.title === "Tagged");
    expect(entry?.tags?.sort()).toEqual(["alpha", "beta"]);
  });

  it("omits tags when include_tags is false", async () => {
    await createFile({ title: "Tagged", content: "body", destination: "knowledge", dataDir, tags: ["x"] });
    const r = whatsNew({ since: "1h", include_tags: false });
    expect(r.files[0].tags).toBeUndefined();
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await createFile({ title: `F${i}`, content: `body ${i}`, destination: "knowledge", dataDir });
    }
    const r = whatsNew({ since: "1h", limit: 2 });
    expect(r.files.length).toBe(2);
  });

  it("orders by updated_at DESC (newest first)", async () => {
    const a = await createFile({ title: "A", content: "a", destination: "knowledge", dataDir });
    const b = await createFile({ title: "B", content: "b", destination: "knowledge", dataDir });
    setTimestamps(a.id, "2026-04-30 10:00:00", "2026-04-30 10:00:00");
    setTimestamps(b.id, "2026-04-30 11:00:00", "2026-04-30 11:00:00");
    const r = whatsNew({ since: "2026-04-30T09:00:00Z" });
    expect(r.files.map((f) => f.title)).toEqual(["B", "A"]);
  });

  it("returns since/until as ISO 8601", () => {
    const r = whatsNew({ since: "1h" });
    expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(r.until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes files modified after a real updateFile() call", async () => {
    const f = await createFile({ title: "Live", content: "first", destination: "knowledge", dataDir });
    setTimestamps(f.id, "2026-01-01 00:00:00", "2026-01-01 00:00:00");
    // Now update — this should bump updated_at to "now".
    await updateFile(f.id, "second pass content body", dataDir);
    const r = whatsNew({ since: "1h" });
    const entry = r.files.find((x) => x.id === f.id);
    expect(entry).toBeDefined();
    expect(entry!.change).toBe("modified");
  });

  it("addTags result is reflected when re-querying with include_tags", async () => {
    const f = await createFile({ title: "TagMe", content: "body content here", destination: "knowledge", dataDir });
    addTags(f.id, ["fresh"]);
    const r = whatsNew({ since: "1h" });
    const entry = r.files.find((x) => x.id === f.id);
    expect(entry?.tags).toContain("fresh");
  });
});
