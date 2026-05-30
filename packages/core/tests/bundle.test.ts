// packages/core/tests/bundle.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { bundleSearch } from "../src/bundle/index.js";

let TEST_DATA_DIR: string;
let TEST_DB_PATH: string;

function seedFile(opts: {
  id: number;
  title: string;
  path: string;
  content: string;
  project_id?: number | null;
}) {
  writeFileSync(opts.path, opts.content);
  const db = getDatabase();
  db.prepare(
    `INSERT INTO files (id, path, title, project_id, storage_type, source_path, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'local', NULL, NULL, datetime('now'), datetime('now'))`
  ).run(opts.id, opts.path, opts.title, opts.project_id ?? null);
  // Mirror the FTS row that createFile() normally inserts.
  db.prepare(
    `INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)`
  ).run(opts.id, opts.title, opts.content);
}

beforeEach(() => {
  TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-bundle-"));
  TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");
  mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });
  createDatabase(TEST_DB_PATH);
});

afterEach(() => {
  closeDatabase();
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("bundleSearch", () => {
  test("returns matched files in rank order (xml format)", async () => {
    const a = join(TEST_DATA_DIR, "knowledge", "alpha.md");
    const b = join(TEST_DATA_DIR, "knowledge", "beta.md");
    seedFile({ id: 1, title: "alpha", path: a, content: "needle apple" });
    seedFile({ id: 2, title: "beta", path: b, content: "needle banana cherry" });

    const res = await bundleSearch({ query: "needle" }, { format: "xml", max_tokens: 10000 });

    expect(res.meta.included.map((f) => f.id)).toEqual(expect.arrayContaining([1, 2]));
    expect(res.meta.included.length).toBe(2);
    expect(res.meta.skipped).toEqual([]);
    expect(res.bundle).toContain("<documents>");
    expect(res.bundle).toContain("</documents>");
    expect(res.bundle).toContain("apple");
    expect(res.bundle).toContain("banana");
  });

  test("budget cap stops on first overflow", async () => {
    const a = join(TEST_DATA_DIR, "knowledge", "a.md");
    const b = join(TEST_DATA_DIR, "knowledge", "b.md");
    const c = join(TEST_DATA_DIR, "knowledge", "c.md");
    // ~25 tokens each at 4 bytes/token => ~100 bytes each
    const body = "needle " + "x".repeat(93);
    seedFile({ id: 1, title: "a", path: a, content: body });
    seedFile({ id: 2, title: "b", path: b, content: body });
    seedFile({ id: 3, title: "c", path: c, content: body });

    // 50 token budget => only 2 files fit, third overflows.
    const res = await bundleSearch({ query: "needle" }, { format: "xml", max_tokens: 50 });

    expect(res.meta.included.length).toBe(2);
    expect(res.meta.skipped.length).toBe(1);
    expect(res.meta.skipped[0].reason).toBe("would_exceed_budget");
  });

  test("zero hits returns empty bundle, not an error", async () => {
    const res = await bundleSearch({ query: "nothingmatchesthis" }, { format: "xml", max_tokens: 1000 });
    expect(res.bundle).toBe("");
    expect(res.meta.included).toEqual([]);
    expect(res.meta.skipped).toEqual([]);
    expect(res.meta.total_est_tokens).toBe(0);
  });

  test("xml escapes ]]> via CDATA-split", async () => {
    const p = join(TEST_DATA_DIR, "knowledge", "evil.md");
    seedFile({ id: 1, title: "evil", path: p, content: "needle before ]]> after" });

    const res = await bundleSearch({ query: "needle" }, { format: "xml", max_tokens: 10000 });

    expect(res.bundle).toContain("]]]]><![CDATA[>");
    expect(res.bundle).not.toMatch(/before \]\]> after/);
  });

  test("markdown format uses ## headers and fenced blocks", async () => {
    const p = join(TEST_DATA_DIR, "knowledge", "doc.md");
    seedFile({ id: 1, title: "doc", path: p, content: "needle hello" });

    const res = await bundleSearch({ query: "needle" }, { format: "markdown", max_tokens: 10000 });

    expect(res.bundle).toMatch(/^## \[1\] /m);
    expect(res.bundle).toMatch(/```md\n[\s\S]*hello[\s\S]*\n```/);
  });

  test("markdown escapes nested triple-backtick fences", async () => {
    const p = join(TEST_DATA_DIR, "knowledge", "nested.md");
    seedFile({ id: 1, title: "nested", path: p, content: "needle\n```js\ncode\n```\n" });

    const res = await bundleSearch({ query: "needle" }, { format: "markdown", max_tokens: 10000 });

    // Wrapping fence must be 4 backticks because content contains 3-backtick fences.
    expect(res.bundle).toMatch(/^````md\n/m);
    expect(res.bundle).toMatch(/\n````\s*$/m);
  });
});
