/**
 * Tests for git operations module
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import simpleGit, { SimpleGit } from "simple-git";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import {
  commitFile,
  getHistory,
  getDiff,
  restoreVersion,
  syncBackup,
} from "../src/git/index.js";

import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-test-"));
const testDir = TEST_DATA_DIR;
const TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");
const EXTERNAL_PROJECT_DIR = join(import.meta.dirname, "external-project");

describe("Git Operations", () => {
  beforeEach(async () => {
    // Clean up test directories
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    if (existsSync(EXTERNAL_PROJECT_DIR)) {
      rmSync(EXTERNAL_PROJECT_DIR, { recursive: true, force: true });
    }

    // Create test data directory structure
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, "backups"), { recursive: true });

    // Initialize git repository in TEST_DATA
    const git: SimpleGit = simpleGit(TEST_DATA_DIR);
    await git.init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test User");
    // Disable git hooks and GPG signing for tests using execSync
    execSync("git config core.hooksPath /dev/null", { cwd: TEST_DATA_DIR });
    execSync("git config commit.gpgsign false", { cwd: TEST_DATA_DIR });

    // Initialize database
    createDatabase(TEST_DB_PATH);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    if (existsSync(EXTERNAL_PROJECT_DIR)) {
      rmSync(EXTERNAL_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  test("commitFile writes a file and commits it with message", async () => {
    const filePath = join(TEST_DATA_DIR, "knowledge", "test.md");
    writeFileSync(filePath, "Initial content", "utf8");

    await commitFile(TEST_DATA_DIR, filePath, "Add test file");

    // Verify commit exists in git log
    const git: SimpleGit = simpleGit(TEST_DATA_DIR);
    const log = await git.log();

    expect(log.latest?.message).toBe("Add test file");
    expect(log.total).toBe(1);
  });

  test("getHistory returns commits in reverse order", async () => {
    const filePath = join(TEST_DATA_DIR, "knowledge", "test.md");

    // First commit
    writeFileSync(filePath, "First content", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "First commit");

    // Wait a bit to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Second commit
    writeFileSync(filePath, "Second content", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "Second commit");

    const history = await getHistory(TEST_DATA_DIR, filePath);

    expect(history).toHaveLength(2);
    expect(history[0].message).toBe("Second commit");
    expect(history[1].message).toBe("First commit");
    expect(history[0].hash).toBeDefined();
    expect(history[0].date).toBeDefined();
    expect(history[0].author).toBe("Test User");
  });

  test("getDiff returns diff between two commits", async () => {
    const filePath = join(TEST_DATA_DIR, "knowledge", "test.md");

    // First commit
    writeFileSync(filePath, "Line 1\nLine 2\n", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "First commit");

    const history1 = await getHistory(TEST_DATA_DIR, filePath);
    const firstHash = history1[0].hash;

    // Second commit
    writeFileSync(filePath, "Line 1\nLine 2 modified\nLine 3\n", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "Second commit");

    const history2 = await getHistory(TEST_DATA_DIR, filePath);
    const secondHash = history2[0].hash;

    const diff = await getDiff(TEST_DATA_DIR, filePath, firstHash, secondHash);

    expect(diff).toContain("-Line 2");
    expect(diff).toContain("+Line 2 modified");
    expect(diff).toContain("+Line 3");
  });

  test("restoreVersion restores file to specific commit", async () => {
    const filePath = join(TEST_DATA_DIR, "knowledge", "test.md");

    // First commit
    writeFileSync(filePath, "Original content", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "First commit");

    const history1 = await getHistory(TEST_DATA_DIR, filePath);
    const firstHash = history1[0].hash;

    // Second commit
    writeFileSync(filePath, "Modified content", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "Second commit");

    // Verify current content
    let content = readFileSync(filePath, "utf8");
    expect(content).toBe("Modified content");

    // Restore to first commit
    const restoredContent = await restoreVersion(
      TEST_DATA_DIR,
      filePath,
      firstHash
    );

    expect(restoredContent).toBe("Original content");

    // Verify file on disk was updated
    content = readFileSync(filePath, "utf8");
    expect(content).toBe("Original content");
  });

  test("syncBackup copies reference files to backup directory and commits", async () => {
    const db = getDatabase();

    // Create external project directory
    mkdirSync(EXTERNAL_PROJECT_DIR, { recursive: true });

    // Create a test file in external directory
    const externalFilePath = join(EXTERNAL_PROJECT_DIR, "test-file.md");
    writeFileSync(externalFilePath, "External file content", "utf8");

    // Register project in database
    db.prepare(
      "INSERT INTO projects (name, slug, description, path) VALUES (?, ?, ?, ?)"
    ).run("Test Project", "test-project", "A test project", EXTERNAL_PROJECT_DIR);

    const project = db
      .prepare("SELECT id FROM projects WHERE slug = ?")
      .get("test-project") as { id: number };

    // Insert a reference file record
    db.prepare(
      "INSERT INTO files (path, title, project_id, storage_type, source_path) VALUES (?, ?, ?, ?, ?)"
    ).run(
      externalFilePath,
      "Test File",
      project.id,
      "reference",
      externalFilePath
    );

    // Call syncBackup
    const copiedPaths = await syncBackup(project.id, TEST_DATA_DIR);

    // Verify backup file was created
    expect(copiedPaths).toHaveLength(1);

    const backupPath = join(
      TEST_DATA_DIR,
      "backups",
      "test-project",
      "test-file.md"
    );
    expect(copiedPaths[0]).toBe(backupPath);
    expect(existsSync(backupPath)).toBe(true);

    // Verify backup file content
    const backupContent = readFileSync(backupPath, "utf8");
    expect(backupContent).toBe("External file content");

    // Verify git commit was made
    const git: SimpleGit = simpleGit(TEST_DATA_DIR);
    const log = await git.log();

    expect(log.latest?.message).toBe("Sync local changes for project: Test Project");
    expect(log.total).toBe(1);
  });
});
