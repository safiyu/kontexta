import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkGit, type GitWatcherState } from "../../src/journal/git-watcher.js";

describe("git-watcher.checkGit", () => {
  let repoDir: string;
  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "kontexta-git-watcher-"));
    execSync("git init -q -b main", { cwd: repoDir });
    execSync("git config user.email test@test", { cwd: repoDir });
    execSync("git config user.name test", { cwd: repoDir });
    execSync("git config commit.gpgsign false", { cwd: repoDir });
    writeFileSync(join(repoDir, "a.txt"), "x");
    execSync("git add a.txt && git commit -q -m initial --no-verify", { cwd: repoDir });
  });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  it("returns events on first call (initial state)", async () => {
    const state: GitWatcherState = { branch: null, head: null };
    const events = await checkGit(repoDir, state);
    expect(events.find((e) => e.event === "git_context")).toBeDefined();
    expect(state.branch).toBe("main");
    expect(state.head).toMatch(/^[0-9a-f]+$/);
  });

  it("returns no events on subsequent unchanged call", async () => {
    const state: GitWatcherState = { branch: null, head: null };
    await checkGit(repoDir, state);
    const events2 = await checkGit(repoDir, state);
    expect(events2.length).toBe(0);
  });

  it("emits git_commit when HEAD advances", async () => {
    const state: GitWatcherState = { branch: null, head: null };
    await checkGit(repoDir, state);
    writeFileSync(join(repoDir, "b.txt"), "y");
    execSync("git add b.txt && git commit -q -m 'feat: add b' --no-verify", { cwd: repoDir });
    const events = await checkGit(repoDir, state);
    const commit = events.find((e) => e.event === "git_commit");
    expect(commit).toBeDefined();
    expect(commit?.msg).toBe("feat: add b");
  });

  it("emits git_context when branch changes", async () => {
    const state: GitWatcherState = { branch: null, head: null };
    await checkGit(repoDir, state);
    execSync("git checkout -q -b feature", { cwd: repoDir });
    const events = await checkGit(repoDir, state);
    expect(events.find((e) => e.event === "git_context" && e.branch === "feature")).toBeDefined();
  });

  it("returns empty array when not a git repo", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "kontexta-not-repo-"));
    const state: GitWatcherState = { branch: null, head: null };
    const events = await checkGit(notRepo, state);
    expect(events).toEqual([]);
    rmSync(notRepo, { recursive: true, force: true });
  });
});
