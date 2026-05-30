/**
 * Tests for file operations module
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import {
  createFile,
  readFile,
  updateFile,
  deleteFile,
  listFiles,
  moveFile,
  computeHash,
  slugify,
  listProjectFolders,
} from "../src/files/index.js";
import { assertPathInside } from "../src/util/safety.js";

import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-test-"));
const testDir = TEST_DATA_DIR;
const TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");

describe("File Operations", () => {
  beforeEach(() => {
    // Clean up and create test data directory
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });

    // Initialize database
    createDatabase(TEST_DB_PATH);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  test("slugify converts name to slug", async () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Test File 123")).toBe("test-file-123");
    expect(slugify("Multiple   Spaces")).toBe("multiple-spaces");
    expect(slugify("Special!@#$%Characters")).toBe("special-characters");
  });

  test("computeHash generates SHA-256 hex digest", async () => {
    const hash = computeHash("test content");
    expect(hash).toHaveLength(64); // SHA-256 produces 64 hex characters
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  test("creates knowledge base file on disk and indexes it", async () => {
    const file = await createFile({
      title: "My Knowledge",
      content: "This is my knowledge base content",
      destination: "knowledge",
      tags: ["test", "knowledge"],
      dataDir: TEST_DATA_DIR,
    });

    expect(file.id).toBeGreaterThan(0);
    expect(file.title).toBe("My Knowledge");
    expect(file.storage_type).toBe("local");
    expect(file.content).toBe("This is my knowledge base content");

    // Verify file exists on disk
    const expectedPath = join(TEST_DATA_DIR, "knowledge", "my-knowledge.md");
    expect(file.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const diskContent = readFileSync(expectedPath, "utf8");
    expect(diskContent).toBe("This is my knowledge base content");

    // Verify FTS index
    const db = getDatabase();
    const ftsResult = db.prepare("SELECT rowid FROM fts_index WHERE fts_index MATCH ?").get("knowledge") as { rowid: number } | undefined;
    expect(ftsResult).toBeDefined();
    expect(ftsResult?.rowid).toBe(file.id);

    // Verify tags
    const tags = db.prepare(`
      SELECT tags.name FROM tags
      JOIN file_tags ON tags.id = file_tags.tag_id
      WHERE file_tags.file_id = ?
    `).all(file.id) as { name: string }[];

    expect(tags.map(t => t.name)).toEqual(expect.arrayContaining(["test", "knowledge"]));
  });

  test("creates kontexta project doc", async () => {
    const db = getDatabase();

    // Create a project first
    db.prepare("INSERT INTO projects (name, slug, description) VALUES (?, ?, ?)").run(
      "Test Project",
      "test-project",
      "A test project"
    );

    const project = db.prepare("SELECT id FROM projects WHERE slug = ?").get("test-project") as { id: number };

    const file = await createFile({
      title: "Project Doc",
      content: "Project documentation content",
      destination: "kontexta",
      projectId: project.id,
      dataDir: TEST_DATA_DIR,
    });

    expect(file.storage_type).toBe("local");
    expect(file.project_id).toBe(project.id);

    // Verify file path is under data/projects/test-project/
    const expectedPath = join(TEST_DATA_DIR, "projects", "test-project", "project-doc.md");
    expect(file.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  test("reads file content by id", async () => {
    const created = await createFile({
      title: "Test Read",
      content: "Content to read",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });

    const read = readFile(created.id);

    expect(read.id).toBe(created.id);
    expect(read.title).toBe("Test Read");
    expect(read.content).toBe("Content to read");
  });

  test("updates file content and hash", async () => {
    const created = await createFile({
      title: "Test Update",
      content: "Original content",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });

    const originalHash = created.content_hash;

    const updated = await updateFile(created.id, "Updated content", TEST_DATA_DIR);

    expect(updated.id).toBe(created.id);
    expect(updated.content_hash).not.toBe(originalHash);
    expect(updated.content_hash).toBe(computeHash("Updated content"));

    // Verify file on disk was updated
    const diskContent = readFileSync(created.path, "utf8");
    expect(diskContent).toBe("Updated content");

    // Verify FTS index was updated by searching
    const db = getDatabase();
    const ftsResult = db.prepare("SELECT rowid FROM fts_index WHERE fts_index MATCH ?").get("Updated") as { rowid: number } | undefined;
    expect(ftsResult).toBeDefined();
    expect(ftsResult?.rowid).toBe(created.id);
  });

  test("soft deletes file", async () => {
    const created = await createFile({
      title: "Test Delete",
      content: "To be deleted",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });

    deleteFile(created.id);

    const db = getDatabase();

    // Verify file is deleted from database
    const fileResult = db.prepare("SELECT * FROM files WHERE id = ?").get(created.id);
    expect(fileResult).toBeUndefined();

    // Verify FTS index is deleted - search should not find it
    const ftsResult = db.prepare("SELECT rowid FROM fts_index WHERE fts_index MATCH ?").get("deleted") as { rowid: number } | undefined;
    // The search might find nothing or might find other files, but shouldn't find our deleted file
    if (ftsResult) {
      expect(ftsResult.rowid).not.toBe(created.id);
    }
  });

  test("lists all files", async () => {
    const file1 = await createFile({
      title: "File 1",
      content: "Content 1",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });

    // Wait at least 1 second to ensure different timestamps (SQLite datetime has second precision)
    await new Promise(resolve => setTimeout(resolve, 1100));

    const file2 = await createFile({
      title: "File 2",
      content: "Content 2",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });

    const files = listFiles({ dataDir: TEST_DATA_DIR });

    expect(files).toHaveLength(2);
    // Files should be ordered by updated_at DESC, so file2 should be first
    expect(files[0].id).toBe(file2.id);
    expect(files[1].id).toBe(file1.id);
  });

  test("filters by storage_type", async () => {
    const db = getDatabase();

    // Create a project
    db.prepare("INSERT INTO projects (name, slug, path) VALUES (?, ?, ?)").run(
      "Test Project",
      "test-project",
      join(TEST_DATA_DIR, "external")
    );

    const project = db.prepare("SELECT id FROM projects WHERE slug = ?").get("test-project") as { id: number };

    await createFile({
      title: "Knowledge File",
      content: "Knowledge",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });

    await createFile({
      title: "Project File",
      content: "Project",
      destination: "project",
      projectId: project.id,
      dataDir: TEST_DATA_DIR,
    });

    const localFiles = listFiles({
      dataDir: TEST_DATA_DIR,
      filters: { storage_type: "local" },
    });

    const referenceFiles = listFiles({
      dataDir: TEST_DATA_DIR,
      filters: { storage_type: "reference" },
    });

    expect(localFiles).toHaveLength(1);
    expect(localFiles[0].title).toBe("Knowledge File");

    expect(referenceFiles).toHaveLength(1);
    expect(referenceFiles[0].title).toBe("Project File");
  });

  test("moves file on disk and updates DB path", async () => {
    const created = await createFile({
      title: "Test Move",
      content: "Move me",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });

    const originalPath = created.path;
    const newPath = join(TEST_DATA_DIR, "knowledge", "moved", "test-move.md");

    const moved = moveFile(created.id, newPath);

    expect(moved.path).toBe(newPath);
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(originalPath)).toBe(false);

    // Verify content is preserved
    const content = readFileSync(newPath, "utf8");
    expect(content).toBe("Move me");
  });

  test("creates a .mmd file when format is 'mmd'", async () => {
    const file = await createFile({
      title: "Flow Diagram",
      content: "graph TD\nA-->B",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
      format: "mmd",
    });
    expect(file.path.endsWith(".mmd")).toBe(true);
    expect(file.path.endsWith(".md.mmd")).toBe(false);
  });

  test("defaults to .md when format is omitted", async () => {
    const file = await createFile({
      title: "Plain Note",
      content: "hello",
      destination: "knowledge",
      dataDir: TEST_DATA_DIR,
    });
    expect(file.path.endsWith(".md")).toBe(true);
  });

  test("listProjectFolders handles symlink loops safely", () => {
    // Synchronous — no floating promise; symlinkSync is imported at top level.
    const projDir = join(TEST_DATA_DIR, "symloop-proj");
    mkdirSync(join(projDir, "src"), { recursive: true });
    // Create a circular symlink: src/loop -> src
    symlinkSync(join(projDir, "src"), join(projDir, "src", "loop"), "dir");

    const folders = listProjectFolders(projDir);
    expect(folders).toContain("src");
    // The symlink itself must be skipped — not recursed into
    expect(folders).not.toContain(join("src", "loop"));
  });
});

describe("Path Safety (assertPathInside)", () => {
  // resolve is imported from node:path at the top of the file (ESM — no require()).

  test("prevents directory traversal", () => {
    expect(() => assertPathInside("/base", "../escaped")).toThrow(/escapes base directory/);
  });
  test("rejects absolute paths", () => {
    expect(() => assertPathInside("/base", "/absolute/path")).toThrow(/absolute paths are not allowed/);
  });
  test("rejects null bytes", () => {
    expect(() => assertPathInside("/base", "file\0name")).toThrow(/null byte/);
  });
  test("resolves valid paths", () => {
    expect(assertPathInside("/base", "sub/file.md")).toBe(join(resolve("/base"), "sub/file.md"));
  });
});
