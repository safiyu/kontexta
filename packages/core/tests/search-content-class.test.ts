import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../src/db/index.js";
import { createFile, listFiles } from "../src/files/index.js";
import { search } from "../src/metadata/index.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "kontexta-search-cc-"));
const DB_PATH = join(TEST_DIR, "test.db");

describe("search — dictionary-wins ordering & content_class filter", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "knowledge"), { recursive: true });
    createDatabase(DB_PATH);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("dictionary hit sorts above note hit for the same query", async () => {
    await createFile({
      title: "Note about widgets",
      content: "widgets are informational notes",
      destination: "knowledge",
      folder: "knowledge/notes/topics",
      dataDir: TEST_DIR,
    });
    await createFile({
      title: "Dictionary widgets",
      content: "widgets are the authoritative definition",
      destination: "knowledge",
      folder: "knowledge/dictionary/topics",
      dataDir: TEST_DIR,
    });

    const results = search({ query: "widgets" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].content_class).toBe("dictionary");
  });

  test("content_class filter narrows search results", async () => {
    await createFile({
      title: "Note X",
      content: "uniquetokenabc lives here",
      destination: "knowledge",
      folder: "knowledge/notes",
      dataDir: TEST_DIR,
    });
    await createFile({
      title: "Dict X",
      content: "uniquetokenabc also here",
      destination: "knowledge",
      folder: "knowledge/dictionary",
      dataDir: TEST_DIR,
    });

    const dictOnly = search({ query: "uniquetokenabc", content_class: "dictionary" });
    expect(dictOnly.length).toBe(1);
    expect(dictOnly[0].content_class).toBe("dictionary");
  });

  test("listFiles supports content_class filter", async () => {
    await createFile({
      title: "Dict",
      content: "d",
      destination: "knowledge",
      folder: "knowledge/dictionary",
      dataDir: TEST_DIR,
    });
    await createFile({
      title: "Note",
      content: "n",
      destination: "knowledge",
      folder: "knowledge/notes",
      dataDir: TEST_DIR,
    });

    const dictOnly = listFiles({ dataDir: TEST_DIR, filters: { content_class: "dictionary" } });
    expect(dictOnly.length).toBe(1);
    expect(dictOnly[0].content_class).toBe("dictionary");
  });
});
