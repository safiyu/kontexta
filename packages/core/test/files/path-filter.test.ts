import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile, listFiles } from "../../src/files/index.js";
import { createDatabase, closeDatabase } from "../../src/db/index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kxta-path-filter-"));
  createDatabase(join(dataDir, "kontexta.db"));
});

describe("listFiles path filter", () => {
  it("returns file by exact path match", async () => {
    const rec1 = await createFile({
      title: "File One",
      content: "Content one",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });
    await createFile({
      title: "File Two",
      content: "Content two",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });
    const results = listFiles({ dataDir, filters: { path: rec1.path } });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(rec1.id);
    expect(results[0].path).toBe(rec1.path);
  });

  it("returns empty array when path does not exist", async () => {
    await createFile({
      title: "Existing File",
      content: "Content",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });
    const results = listFiles({ dataDir, filters: { path: "/nonexistent/path.md" } });
    expect(results).toHaveLength(0);
  });

  it("works with folder parameter in path", async () => {
    const rec = await createFile({
      title: "Nested File",
      content: "Content",
      destination: "knowledge",
      folder: "knowledge/publish",
      dataDir,
    });
    const results = listFiles({ dataDir, filters: { path: rec.path } });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(rec.path);
  });
});

afterEach(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});
