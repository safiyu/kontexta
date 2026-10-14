/**
 * Tests for git operations module
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import simpleGit, { SimpleGit } from "simple-git";
import { createDatabase, closeDatabase } from "../src/db/index.js";
import {
  commitFile,
  getHistory,
  getDiff,
  restoreVersion,
  syncGlobalVault,
  isValidGitRemoteUrl,
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

    // Isolate from any inaccessible system/global .gitconfig on CI runners
    // (e.g. Windows GitHub Actions: 'C:/Users/runneradmin/.gitconfig: Permission denied',
    //  Linux runners: permission errors reading /root/.gitconfig)
    const nullPath = platform() === "win32" ? "NUL" : "/dev/null";
    const isolatedEnv: Record<string, string | undefined> = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullPath,  // skip ~/.gitconfig entirely
      HOME: TEST_DATA_DIR,          // points git's home lookup at our temp dir
      USERPROFILE: TEST_DATA_DIR,   // Windows equivalent of HOME
    };
    // Strip vars simple-git's block-unsafe-operations-plugin rejects unless
    // explicitly allowlisted (we only allowlist allowUnsafeConfigPaths above).
    // A dev shell that exports GIT_EDITOR/GIT_PAGER/etc. would otherwise make
    // this suite fail outside CI, since we spread process.env above.
    for (const k of ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "EDITOR", "PAGER", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_CONFIG_COUNT"]) {
      delete isolatedEnv[k];
    }

    // Initialize git repository in TEST_DATA
    // unsafe.allowUnsafeConfigPaths required so simple-git's security plugin permits
    // GIT_CONFIG_GLOBAL in the env we pass.
    const git: SimpleGit = simpleGit(TEST_DATA_DIR, { unsafe: { allowUnsafeConfigPaths: true } });
    await git.env(isolatedEnv).init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test User");
    // Disable GPG signing and hooks entirely in the local repo config
    await git.addConfig("commit.gpgsign", "false");
    // Use a cross-platform no-op hooks path
    execSync(`git config core.hooksPath ${nullPath}`, { cwd: TEST_DATA_DIR, env: isolatedEnv });

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
    const git: SimpleGit = simpleGit(TEST_DATA_DIR, { unsafe: { allowUnsafeConfigPaths: true } });
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

  test("syncGlobalVault is a no-op when no remote is configured", async () => {
    // Ensure the repo has a commit so HEAD exists.
    const filePath = join(TEST_DATA_DIR, "knowledge", "vault.md");
    writeFileSync(filePath, "Vault content", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "Add vault file");

    // No origin configured → syncGlobalVault must return without touching
    // the network and without throwing.
    const stages: string[] = [];
    await syncGlobalVault(TEST_DATA_DIR, (s) => stages.push(s));
    expect(stages[stages.length - 1]).toBe("done");
  });

  test("syncGlobalVault rejects an invalid (local) remote URL before any network step", async () => {
    // A commit so HEAD exists, then point origin at a local path — valid git,
    // but isValidGitRemoteUrl rejects it (only https/ssh/git/scp-form allowed).
    const filePath = join(TEST_DATA_DIR, "knowledge", "vault.md");
    writeFileSync(filePath, "Vault content", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "Add vault file");

    const git: SimpleGit = simpleGit(TEST_DATA_DIR, { unsafe: { allowUnsafeConfigPaths: true } });
    await git.addRemote("origin", join(TEST_DATA_DIR, "remote.git"));

    const stages: string[] = [];
    await expect(
      syncGlobalVault(TEST_DATA_DIR, (s) => stages.push(s))
    ).rejects.toThrow("not a valid git remote");

    // It failed at validation, before reaching pull.
    expect(stages).not.toContain("pulling remote");
  });

  test("syncGlobalVault passes a valid remote URL through validation and fails at pull", async () => {
    // Same setup, but with a syntactically-valid https remote that is
    // unreachable. Reaching the pull error (instead of the validation error)
    // proves validation passed first.
    const filePath = join(TEST_DATA_DIR, "knowledge", "vault.md");
    writeFileSync(filePath, "Vault content", "utf8");
    await commitFile(TEST_DATA_DIR, filePath, "Add vault file");

    const git: SimpleGit = simpleGit(TEST_DATA_DIR, { unsafe: { allowUnsafeConfigPaths: true } });
    await git.addRemote("origin", "https://github.com/kontexta/definitely-not-a-real-repo.git");

    const stages: string[] = [];
    await expect(
      syncGlobalVault(TEST_DATA_DIR, (s) => stages.push(s))
    ).rejects.toThrow("Sync failed during pull");

    // Validation was satisfied — we actually attempted the network pull.
    expect(stages).toContain("pulling remote");
    expect(stages).not.toContain("not a valid git remote");
  });

  test("isValidGitRemoteUrl only accepts https/ssh/git/scp-form URLs", () => {
    expect(isValidGitRemoteUrl("https://github.com/acme/kb.git")).toBe(true);
    expect(isValidGitRemoteUrl("ssh://git@github.com/acme/kb.git")).toBe(true);
    expect(isValidGitRemoteUrl("git@github.com:acme/kb.git")).toBe(true);
    expect(isValidGitRemoteUrl("git://github.com/acme/kb.git")).toBe(true);
    expect(isValidGitRemoteUrl("http://github.com/acme/kb.git")).toBe(false); // cleartext
    expect(isValidGitRemoteUrl("/tmp/local/remote.git")).toBe(false); // local path
    expect(isValidGitRemoteUrl("file:///tmp/remote.git")).toBe(false);
    expect(isValidGitRemoteUrl("")).toBe(false);
  });
});
