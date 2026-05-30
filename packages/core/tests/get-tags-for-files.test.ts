import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, closeDatabase } from "../src/db/index.js";
import { createFile } from "../src/files/index.js";
import { addTags, getTagsForFiles } from "../src/metadata/index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kontexta-tags-"));
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  createDatabase(join(dataDir, "test.db"));
});
afterEach(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("getTagsForFiles", () => {
  it("returns empty map for empty input (no DB hit)", () => {
    expect(getTagsForFiles([]).size).toBe(0);
  });

  it("returns tags for one file", async () => {
    const f = await createFile({ title: "A", content: "body".repeat(20), destination: "knowledge", dataDir, tags: ["one", "two"] });
    const map = getTagsForFiles([f.id]);
    expect(map.get(f.id)?.sort()).toEqual(["one", "two"]);
  });

  it("returns a single Map keyed by file_id for many files", async () => {
    const a = await createFile({ title: "A", content: "a".repeat(50), destination: "knowledge", dataDir, tags: ["x"] });
    const b = await createFile({ title: "B", content: "b".repeat(50), destination: "knowledge", dataDir, tags: ["y", "z"] });
    const c = await createFile({ title: "C", content: "c".repeat(50), destination: "knowledge", dataDir });
    const map = getTagsForFiles([a.id, b.id, c.id]);
    expect(map.get(a.id)).toEqual(["x"]);
    expect(map.get(b.id)?.sort()).toEqual(["y", "z"]);
    expect(map.get(c.id)).toBeUndefined();
  });

  it("reflects tags added after createFile", async () => {
    const f = await createFile({ title: "Late", content: "body".repeat(20), destination: "knowledge", dataDir });
    addTags(f.id, ["fresh", "another"]);
    const map = getTagsForFiles([f.id]);
    expect(map.get(f.id)?.sort()).toEqual(["another", "fresh"]);
  });

  it("ignores unknown ids without throwing", () => {
    const map = getTagsForFiles([99999, 99998]);
    expect(map.size).toBe(0);
  });
});
