/**
 * Tests for metadata module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { createFile } from "../src/files/index.js";
import {
  addTags,
  removeTags,
  setFavorite,
  search,
  registerProject,
  unregisterProject,
  discoverFiles,
  refreshIndex,
  listTags,
  listProjects,
  findRelated,
} from "../src/metadata/index.js";
import { chmodSync } from "node:fs";

import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-test-"));
const testDir = TEST_DATA_DIR;
const dbPath = join(testDir, "test.db");
const dataDir = join(testDir, "data");

describe("Metadata Module", () => {
  beforeEach(() => {
    // Clean up from previous test
    rmSync(testDir, { recursive: true, force: true });

    // Create test directories
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(dataDir, "knowledge"), { recursive: true });

    // Initialize database
    createDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("addTags: adds tags to a file and verifies via listTags", async () => {
    // Create a test file
    const file = await createFile({
      title: "Test File",
      content: "Test content",
      destination: "knowledge",
      dataDir,
    });

    // Add tags
    addTags(file.id, ["tag1", "tag2"]);

    // Verify tags were created
    const tags = listTags();
    expect(tags).toHaveLength(2);
    expect(tags.map((t) => t.name)).toContain("tag1");
    expect(tags.map((t) => t.name)).toContain("tag2");

    // Verify tags are linked to the file
    const db = getDatabase();
    const fileTags = db
      .prepare(
        `
      SELECT tags.name FROM file_tags
      JOIN tags ON tags.id = file_tags.tag_id
      WHERE file_tags.file_id = ?
      ORDER BY tags.name
    `
      )
      .all(file.id) as { name: string }[];

    expect(fileTags).toHaveLength(2);
    expect(fileTags[0].name).toBe("tag1");
    expect(fileTags[1].name).toBe("tag2");
  });

  it("removeTags: removes specific tags from a file", async () => {
    // Create a test file
    const file = await createFile({
      title: "Test File",
      content: "Test content",
      destination: "knowledge",
      dataDir,
    });

    // Add two tags
    addTags(file.id, ["tag1", "tag2"]);

    // Get tag IDs
    const db = getDatabase();
    const tag1 = db.prepare("SELECT id FROM tags WHERE name = ?").get("tag1") as { id: number };

    // Remove tag1
    removeTags(file.id, [tag1.id]);

    // Verify only tag2 remains
    const fileTags = db
      .prepare(
        `
      SELECT tags.name FROM file_tags
      JOIN tags ON tags.id = file_tags.tag_id
      WHERE file_tags.file_id = ?
    `
      )
      .all(file.id) as { name: string }[];

    expect(fileTags).toHaveLength(1);
    expect(fileTags[0].name).toBe("tag2");
  });

  it("setFavorite: toggles favorite status", async () => {
    // Create a test file
    const file = await createFile({
      title: "Test File",
      content: "Test content",
      destination: "knowledge",
      dataDir,
    });

    const db = getDatabase();

    // Set as favorite
    setFavorite(file.id, true);

    // Verify in DB
    let favorite = db.prepare("SELECT * FROM favorites WHERE file_id = ?").get(file.id);
    expect(favorite).toBeTruthy();

    // Unset favorite
    setFavorite(file.id, false);

    // Verify removed from DB
    favorite = db.prepare("SELECT * FROM favorites WHERE file_id = ?").get(file.id);
    expect(favorite).toBeUndefined();
  });

  it("search: finds files by content keyword", async () => {
    // Create two files with different content
    const file1 = await createFile({
      title: "File One",
      content: "This file contains the keyword unicorn",
      destination: "knowledge",
      dataDir,
    });

    const file2 = await createFile({
      title: "File Two",
      content: "This file contains different content",
      destination: "knowledge",
      dataDir,
    });

    // Search for "unicorn"
    const results = search({ query: "unicorn" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(file1.id);
    expect(results[0].title).toBe("File One");
    expect(results[0].rank).toBeDefined();
  });

  it("search: finds files by title", async () => {
    // Create files
    await createFile({
      title: "Important Document",
      content: "Some content here",
      destination: "knowledge",
      dataDir,
    });

    await createFile({
      title: "Other File",
      content: "Different content",
      destination: "knowledge",
      dataDir,
    });

    // Search for "Important"
    const results = search({ query: "Important" });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Important Document");
  });

  it("registerProject: creates project with correct slug", async () => {
    // Register project
    const project = registerProject("My Test Project", "/path/to/project", "A test project");

    expect(project.name).toBe("My Test Project");
    expect(project.slug).toBe("my-test-project");
    expect(project.path).toBe("/path/to/project");
    expect(project.description).toBe("A test project");
    expect(project.id).toBeDefined();
    expect(project.created_at).toBeDefined();
  });

  it("unregisterProject: removes project and associated files", async () => {
    // 1. Create a project and some files
    const project = registerProject("Unregister Test", "/tmp/unregister-test");
    
    // Create a mock file in the project
    const db = getDatabase();
    const fileResult = db.prepare(
      "INSERT INTO files (path, title, project_id, storage_type) VALUES (?, ?, ?, 'reference')"
    ).run("/tmp/unregister-test/file.md", "Project File", project.id);
    const fileId = Number(fileResult.lastInsertRowid);
    
    // Index it
    db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(fileId, "Project File", "Test content");

    // 2. Unregister
    unregisterProject(project.id);

    // 3. Verify project is gone
    const projectCheck = db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);
    expect(projectCheck).toBeUndefined();

    // 4. Verify files are gone
    const fileCheck = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId);
    expect(fileCheck).toBeUndefined();

    // 5. Verify FTS is gone
    const ftsCheck = search({ query: "Project" });
    expect(ftsCheck).toHaveLength(0);
  });

  it("refreshIndex: concurrent calls for the same scope are serialized (no duplicate work)", async () => {
    const kbDir = join(dataDir, "knowledge");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "a.md"), "# A\nalpha");
    writeFileSync(join(kbDir, "b.md"), "# B\nbeta");

    // Fire two refreshes simultaneously. With withLock they serialize:
    // the second sees no work to do (newly_indexed = 0).
    const [first, second] = await Promise.all([
      refreshIndex(null, dataDir),
      refreshIndex(null, dataDir),
    ]);

    expect(first.newly_indexed + second.newly_indexed).toBe(2);
    // One of them did all the indexing; the other was a no-op.
    expect(Math.min(first.newly_indexed, second.newly_indexed)).toBe(0);
    expect(Math.max(first.newly_indexed, second.newly_indexed)).toBe(2);
  });

  it("refreshIndex (KB scope): does NOT prune rows when top-level readdir fails", async () => {
    // Set up a KB with one file already indexed.
    const kbDir = join(dataDir, "knowledge");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "important.md"), "# Important\nDo not lose me");
    await refreshIndex(null, dataDir);

    const db = getDatabase();
    const before = db
      .prepare("SELECT COUNT(*) as c FROM files WHERE project_id IS NULL")
      .get() as { c: number };
    expect(before.c).toBe(1);

    // Simulate EACCES on the KB root: chmod 000 (skip on Windows / root user).
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    try {
      chmodSync(kbDir, 0o000);

      // The bug: prior to the fix, this silently pruned the indexed file.
      const result = await refreshIndex(null, dataDir);

      const after = db
        .prepare("SELECT COUNT(*) as c FROM files WHERE project_id IS NULL")
        .get() as { c: number };
      expect(after.c, "KB rows must NOT be wiped on a transient EACCES").toBe(1);
      expect(result.pruned).toBe(0);
    } finally {
      // Restore so afterEach rmSync can delete the dir.
      chmodSync(kbDir, 0o755);
    }
  });

  it("discoverFiles: finds markdown files in project directory", async () => {
    // Create a temp directory with test files
    const projectPath = join(testDir, "test-project");
    mkdirSync(projectPath, { recursive: true });

    writeFileSync(join(projectPath, "readme.md"), "# README\nProject documentation");
    writeFileSync(join(projectPath, "notes.md"), "# Notes\nSome notes here");
    writeFileSync(join(projectPath, "script.ts"), "// TypeScript file");

    // Register project
    const project = registerProject("Test Project", projectPath);

    // Discover files
    const files = discoverFiles(project.id, dataDir);

    // Should find 2 .md files, not the .ts file
    expect(files).toHaveLength(2);

    const titles = files.map((f) => f.title).sort();
    expect(titles).toEqual(["notes", "readme"]);

    // Verify files have correct properties
    files.forEach((file) => {
      expect(file.project_id).toBe(project.id);
      expect(file.storage_type).toBe("reference");
      expect(file.content_hash).toBeDefined();
    });
  });

  it("discoverFiles: indexes .mmd files alongside .md", async () => {
    const projectPath = join(testDir, "test-project-mmd");
    mkdirSync(projectPath, { recursive: true });

    writeFileSync(join(projectPath, "intro.md"), "# Intro\nWelcome");
    writeFileSync(join(projectPath, "flow.mmd"), "graph TD\nA-->B");

    const project = registerProject("Test Project MMD", projectPath);

    const files = discoverFiles(project.id, dataDir);

    expect(files).toHaveLength(2);

    const titles = files.map((f) => f.title).sort();
    expect(titles).toEqual(["flow", "intro"]);

    const mmdFile = files.find((f) => f.path.endsWith(".mmd"));
    expect(mmdFile).toBeDefined();
    expect(mmdFile!.title).not.toContain(".mmd");
  });

  it("listProjects: returns all projects sorted by name", async () => {
    // Register two projects
    registerProject("Zeta Project", "/path/to/zeta");
    registerProject("Alpha Project", "/path/to/alpha");

    // List projects
    const projects = listProjects();

    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe("Alpha Project");
    expect(projects[1].name).toBe("Zeta Project");
  });

  describe("findRelated", () => {
    it("ranks by shared tag count, excludes the source file, returns shared tag names", async () => {
      const a = await createFile({ title: "A", content: "x", destination: "knowledge", dataDir });
      const b = await createFile({ title: "B", content: "x", destination: "knowledge", dataDir });
      const c = await createFile({ title: "C", content: "x", destination: "knowledge", dataDir });
      const d = await createFile({ title: "D", content: "x", destination: "knowledge", dataDir });

      addTags(a.id, ["auth", "security", "architecture"]);
      addTags(b.id, ["auth", "security"]);            // shares 2 with A
      addTags(c.id, ["auth"]);                         // shares 1 with A
      addTags(d.id, ["unrelated"]);                    // shares 0

      const related = findRelated(a.id);

      expect(related.map((r) => r.id)).toEqual([b.id, c.id]);
      expect(related[0].shared_tag_count).toBe(2);
      expect(related[0].shared_tags.sort()).toEqual(["auth", "security"]);
      expect(related[1].shared_tag_count).toBe(1);
      expect(related[1].shared_tags).toEqual(["auth"]);
      expect(related.find((r) => r.id === a.id)).toBeUndefined();
      expect(related.find((r) => r.id === d.id)).toBeUndefined();
    });

    it("returns empty array when the source file has no tags", async () => {
      const f = await createFile({ title: "F", content: "x", destination: "knowledge", dataDir });
      expect(findRelated(f.id)).toEqual([]);
    });

    it("respects the limit parameter", async () => {
      const src = await createFile({ title: "S", content: "x", destination: "knowledge", dataDir });
      addTags(src.id, ["common"]);
      for (let i = 0; i < 5; i++) {
        const other = await createFile({ title: `O${i}`, content: "x", destination: "knowledge", dataDir });
        addTags(other.id, ["common"]);
      }
      expect(findRelated(src.id, 3)).toHaveLength(3);
    });
  });
});
