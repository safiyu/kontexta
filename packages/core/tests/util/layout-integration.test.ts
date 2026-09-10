import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { createFile, createFolder, moveFile } from "../../src/files/index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kxta-layout-"));
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  createDatabase(join(dataDir, "test.db"));
});

afterEach(() => {
  closeDatabase();
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
});

describe("createFile enforces layout at knowledge/ root", () => {
  test("rejects a plain .md at knowledge root (no folder)", async () => {
    await expect(
      createFile({ title: "Loose Note", content: "x", destination: "knowledge", dataDir })
    ).rejects.toThrow(/profile\.md/);
  });

  test("rejects a folder outside the allowlist", async () => {
    await expect(
      createFile({ title: "In Random", content: "x", destination: "knowledge", folder: "random", dataDir })
    ).rejects.toThrow(/journal.*knowledge.*mermaid.*html/);
  });

  test("rejects wrong extension for the folder (mmd in journal/)", async () => {
    await expect(
      createFile({ title: "Bad", content: "x", destination: "knowledge", folder: "journal", format: "mmd", dataDir })
    ).rejects.toThrow(/journal.*\.md/);
  });

  test("allows profile.md at root", async () => {
    const rec = await createFile({
      title: "profile",
      content: "# Name\n# Role\n# Vision\n# Roadmap\n# Preferences\n# Notes\n",
      destination: "knowledge",
      dataDir,
    });
    expect(rec.path).toBe(join(dataDir, "knowledge", "profile.md"));
  });

  test("allows html/*.html and html/resources/*", async () => {
    const page = await createFile({
      title: "Report",
      content: "<h1>hi</h1>",
      destination: "knowledge",
      folder: "html",
      format: "html",
      dataDir,
    });
    expect(page.path).toContain("knowledge/html/");
  });
});

describe("createFolder enforces layout when base is the KB root", () => {
  test("rejects an off-spec folder at knowledge root", () => {
    const base = join(dataDir, "knowledge");
    expect(() => createFolder(base, "random", { dataDir })).toThrow(
      /journal.*knowledge.*mermaid.*html/
    );
  });

  test("allows each of the four allowlist folders", () => {
    const base = join(dataDir, "knowledge");
    for (const name of ["journal", "knowledge", "mermaid", "html"]) {
      expect(() => createFolder(base, name, { dataDir })).not.toThrow();
    }
  });

  test("allows arbitrary subfolders inside an allowlist folder", () => {
    const base = join(dataDir, "knowledge");
    expect(() => createFolder(base, "journal/2026/09", { dataDir })).not.toThrow();
    expect(() => createFolder(base, "html/reports", { dataDir })).not.toThrow();
  });

  test("does NOT enforce when base is not the KB root", () => {
    const otherBase = join(dataDir, "elsewhere");
    mkdirSync(otherBase, { recursive: true });
    expect(() => createFolder(otherBase, "anything", { dataDir })).not.toThrow();
  });
});

describe("moveFile enforces layout on destination for KB files", () => {
  test("rejects moving a KB file to a non-allowlist folder at root", async () => {
    const rec = await createFile({
      title: "Movable",
      content: "hi",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });
    const badDest = join(dataDir, "knowledge", "random", "movable.md");
    expect(() => moveFile(rec.id, badDest, dataDir)).toThrow(/journal.*knowledge.*mermaid.*html/);
  });

  test("rejects a KB file move that ends up with wrong extension", async () => {
    const rec = await createFile({
      title: "Movable",
      content: "hi",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });
    const badDest = join(dataDir, "knowledge", "mermaid", "movable.md");
    expect(() => moveFile(rec.id, badDest, dataDir)).toThrow(/mermaid.*\.mmd/);
  });

  test("allows a KB file move into a valid layout destination", async () => {
    const rec = await createFile({
      title: "Movable",
      content: "hi",
      destination: "knowledge",
      folder: "knowledge",
      dataDir,
    });
    const goodDest = join(dataDir, "knowledge", "knowledge", "moved", "movable.md");
    const moved = moveFile(rec.id, goodDest, dataDir);
    expect(moved.path).toBe(goodDest);
  });
});
