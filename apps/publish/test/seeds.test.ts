import { describe, it, expect, beforeAll } from "vitest";
import { createSeedReader } from "../src/seeds/seeds.js";
import type { VaultReader } from "../src/source/reader.js";

describe("createSeedReader", () => {
  let reader: VaultReader;

  beforeAll(() => {
    reader = createSeedReader();
  });

  it("returns the seeds folder from listFolders", () => {
    const folders = reader.listFolders();
    expect(folders).toContain("seeds");
    expect(folders.length).toBe(1);
  });

  it("returns seed docs for the seeds folder", () => {
    const docs = reader.listDocs("seeds");
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.length).toBe(4); // 01-overview, 02-api, 03-improvements, 04-glossary
  });

  it("returns empty array for unknown folder", () => {
    const docs = reader.listDocs("unknown");
    expect(docs).toEqual([]);
  });

  it("reads a seed doc by id", () => {
    const doc = reader.read(1);
    expect(doc.id).toBe(1);
    expect(doc.path).toBe("/seeds/01-overview.md");
    expect(doc.title).toBe("Overview");
    expect(doc.content).toContain("kontexta Publish");
  });

  it("reads all seed docs", () => {
    const docs = reader.listDocs("seeds");
    for (const meta of docs) {
      const doc = reader.read(meta.id);
      expect(doc.id).toBe(meta.id);
      expect(doc.path).toBe(meta.path);
      expect(doc.title).toBe(meta.title);
      expect(doc.content.length).toBeGreaterThan(0);
    }
  });

  it("seed docs have valid frontmatter titles", () => {
    const docs = reader.listDocs("seeds");
    for (const meta of docs) {
      const doc = reader.read(meta.id);
      expect(doc.title).toBeTruthy();
      expect(typeof doc.title).toBe("string");
      expect(doc.title.length).toBeGreaterThan(0);
    }
  });

  it("seed docs have unique ids", () => {
    const docs = reader.listDocs("seeds");
    const ids = docs.map((d) => d.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("seed docs have unique paths", () => {
    const docs = reader.listDocs("seeds");
    const paths = docs.map((d) => d.path);
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(paths.length);
  });
});
