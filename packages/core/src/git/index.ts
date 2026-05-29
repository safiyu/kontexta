/**
 * Git operations module for Kontexta
 * Handles commit, history, diff, restore, and backup sync operations
 */

import { createHash } from "node:crypto";
import simpleGit, { SimpleGit, LogResult } from "simple-git";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, lstatSync, unlinkSync, renameSync } from "node:fs";
import { join, relative, dirname, isAbsolute, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { getDatabase } from "../db/index.js";
import { withLock } from "../util/safety.js";
import type { ProjectRecord, FileRecord } from "../types.js";
import { stripIndexedExt } from "../util/extensions.js";

// Strip `user:pass@` from URLs in git stderr before logging or returning.
function redactCredentials(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^:@\/\s]+:[^@\/\s]+)@/gi, "$1***:***@");
}

// Strip env that would let git spawn an editor/pager/credential helper —
// any of those would hang a server-side request.
function buildGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const k of [
    "PAGER", "EDITOR", "VISUAL",
    "GIT_EDITOR", "GIT_PAGER", "GIT_SEQUENCE_EDITOR",
    "GIT_ASKPASS", "SSH_ASKPASS",
    "GIT_PROXY_COMMAND", "GIT_HTTP_USER_AGENT", "GIT_EXTERNAL_DIFF",
  ]) {
    delete env[k];
  }
  return env;
}

function gitFor(dir: string): SimpleGit {
  return simpleGit(dir).env(buildGitEnv() as any);
}

/** Validate a git remote URL. Allows https://, ssh://, git://, scp-form (user@host:path). */
export function isValidGitRemoteUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  if (/[\s\x00-\x1f]/.test(url)) return false;
  if (/^(file|ext):/i.test(url)) return false;
  if (/^[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return true; // scp-form
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "ssh:" || u.protocol === "git:";
  } catch {
    return false;
  }
}

/**
 * Ensure a directory is a git repository
 * @param dir - Directory path
 */
export async function ensureGitRepo(dir: string): Promise<void> {
  if (existsSync(join(dir, ".git"))) return;

  const git: SimpleGit = gitFor(dir);
  try {
    await git.init();
    // Prevent "dubious ownership" errors in Docker/mounted volumes
    try {
      await git.addConfig("safe.directory", dir, true, "global");
    } catch (e) {
      // Ignore if global config is not writable, though it usually is in Docker.
    }
    await git.addConfig("user.email", "kontexta@local");
    await git.addConfig("user.name", "Kontexta");
    await git.addConfig("commit.gpgsign", "false");
    await git.addConfig("tag.gpgsign", "false");
  } catch (error) {
    console.warn(`Failed to initialize git in ${dir}:`, error);
  }
}

/**
 * Commit a file to git repository
 * @param repoDir - Root directory of the git repository
 * @param filePath - Absolute path to the file to commit
 * @param message - Commit message
 */
export async function commitFile(
  repoDir: string,
  filePath: string,
  message: string
): Promise<void> {
  await withLock(`git:${resolve(repoDir)}`, async () => {
    await ensureGitRepo(repoDir);
    const git: SimpleGit = gitFor(repoDir);
    const relativePath = relative(repoDir, filePath);
    await git.add(["-f", relativePath]);
    // Path-scoped commit so concurrent activity in the repo can't get swept in.
    await git.commit(message, [relativePath], { "--no-verify": null, "--no-gpg-sign": null });
  });
}

/**
 * Get commit history for a file
 * @param repoDir - Root directory of the git repository
 * @param filePath - Absolute path to the file
 * @returns Array of commit history objects
 */
export async function getHistory(
  repoDir: string,
  filePath: string
): Promise<Array<{ hash: string; message: string; date: string; author: string }>> {
  const git: SimpleGit = gitFor(repoDir);
  const relativePath = relative(repoDir, filePath);

  const log: LogResult = await git.log({ file: relativePath });

  return log.all.map((commit) => ({
    hash: commit.hash,
    message: commit.message,
    date: commit.date,
    author: commit.author_name,
  }));
}

/**
 * Get diff between two commits for a file
 * @param repoDir - Root directory of the git repository
 * @param filePath - Absolute path to the file
 * @param commitA - First commit hash
 * @param commitB - Second commit hash
 * @returns Diff string
 */
export async function getDiff(
  repoDir: string,
  filePath: string,
  commitA: string,
  commitB: string
): Promise<string> {
  const git: SimpleGit = gitFor(repoDir);
  const relativePath = relative(repoDir, filePath);

  const diff = await git.diff([`${commitA}..${commitB}`, "--", relativePath]);

  return diff;
}

/**
 * Restore a file to a specific commit version
 * @param repoDir - Root directory of the git repository
 * @param filePath - Absolute path to the file
 * @param commitHash - Commit hash to restore from
 * @returns Content of the file at the specified commit
 */
export async function restoreVersion(
  repoDir: string,
  filePath: string,
  commitHash: string
): Promise<string> {
  return await withLock(`git:${resolve(repoDir)}`, async () => {
    const git: SimpleGit = gitFor(repoDir);
    const relativePath = relative(repoDir, filePath);

    // cat-file (not simple-git's `show`) so non-utf-8 bytes survive intact.
    const result = spawnSync(
      "git",
      ["-C", repoDir, "cat-file", "-p", `${commitHash}:${relativePath}`],
      { env: buildGitEnv() as NodeJS.ProcessEnv, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
    );
    if (result.status !== 0) {
      const err = result.stderr ? result.stderr.toString() : "unknown";
      throw new Error(`git cat-file failed: ${err.trim()}`);
    }
    const contentBuffer = result.stdout as Buffer;
    const contentForFts = contentBuffer.toString("utf-8");

    // Atomic disk write via tmp + rename: if the rename fails, the
    // original file content is preserved AND we haven't touched the DB.
    // If the rename succeeds, we then update DB+FTS — and if that throws,
    // we have a known-good disk state to compare against (the old hash
    // recorded in DB no longer matches but the watcher will reconcile
    // on the next change event).
    const tmpPath = `${filePath}.kontexta-restore-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, contentBuffer);
    try {
      renameSync(tmpPath, filePath); // atomic on same filesystem
    } catch (e) {
      try { unlinkSync(tmpPath); } catch {}
      throw e;
    }

    const db = getDatabase();
    const file = db.prepare("SELECT id, title FROM files WHERE path = ?").get(filePath) as
      | { id: number; title: string }
      | undefined;
    if (!file) {
      // Disk has been restored, but no DB row exists for this path. The
      // watcher will ingest it on the next change event; surface so this
      // window of FTS-staleness isn't silent.
      console.warn(
        `restoreVersion: no DB row for ${filePath}; disk restored, relying on watcher to (re-)ingest`
      );
    }
    if (file) {
      const hash = createHash("sha256").update(contentBuffer).digest("hex");
      const updateStmt = db.prepare("UPDATE files SET content_hash = ?, updated_at = datetime('now') WHERE id = ?");
      const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
      const insertFtsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");
      try {
        db.transaction(() => {
          updateStmt.run(hash, file.id);
          deleteFtsStmt.run(file.id);
          insertFtsStmt.run(file.id, file.title, contentForFts);
        })();
      } catch (e) {
        // Disk is the source of truth; the watcher will re-sync FTS on
        // the next change. Surface so the API layer can warn the user.
        console.error("restoreVersion: DB/FTS sync failed (disk is restored):", e);
        throw new Error(`Restored on disk but DB/FTS update failed: ${(e as any)?.message ?? e}`);
      }
    }

    try {
      // -f matches commitFile so a restored gitignored file isn't silently skipped.
      await git.add(["-f", relativePath]);
      // Path-scoped: unrelated staged changes are not committed here.
      await git.commit(`Restore version ${commitHash.slice(0, 7)}`, [relativePath], { "--no-verify": null, "--no-gpg-sign": null });
    } catch (e: any) {
      // Swallow only the no-op case (restored content matches HEAD).
      const msg = String(e?.message ?? e);
      const isNoop = /nothing to commit|no changes added to commit|nothing added to commit/i.test(msg);
      if (!isNoop) {
        throw new Error(`Restored on disk but git commit failed: ${msg}`);
      }
    }

    return contentForFts;
  });
}

/**
 * Sync backup copies of project reference files
 * @param projectId - ID of the project
 * @param dataDir - Data directory path
 * @returns Array of copied file paths
 */
/**
 * Sync the global "vault" — dataDir's own git repo — against the configured
 * global remote, INDEPENDENT of any project. Picks up KB file commits that
 * commitFile() made during creates/edits and pushes them upstream.
 *
 * Sync All previously only ran pull/push as a side-effect of per-project
 * `syncBackup` calls, so users with zero projects never had their KB
 * synced even with a global remote URL configured.
 */
export async function syncGlobalVault(
  dataDir: string,
  onStage?: (stage: SyncStage) => void
): Promise<void> {
  return await withLock(`git:${resolve(dataDir)}`, async () => {
    const stage = (s: SyncStage) => { try { onStage?.(s); } catch {} };
    stage("preparing");

    const git = gitFor(dataDir);
    try {
      await git.status();
    } catch {
      await git.init();
      await git.addConfig("user.email", "kontexta@local");
      await git.addConfig("user.name", "Kontexta");
      await git.addConfig("commit.gpgsign", "false");
      await git.addConfig("tag.gpgsign", "false");
    }

    const globalRemoteUrl = await getGlobalRemote(dataDir);
    if (!globalRemoteUrl) {
      stage("done");
      return; // nothing to sync against
    }
    if (!isValidGitRemoteUrl(globalRemoteUrl)) {
      throw new Error("Configured global remote URL is not a valid git remote");
    }

    // Make sure HEAD exists; an empty repo can't push.
    try { await git.raw(["rev-parse", "HEAD"]); }
    catch { await git.commit("Initial commit", ["--allow-empty"], { "--no-gpg-sign": null }); }

    // Pull → merge → push.
    let pullSucceeded = false;
    stage("pulling remote");
    try {
      await git.pull("origin", "main", { "--rebase": "false" });
      pullSucceeded = true;
      stage("merging remote");
    } catch (e) {
      const msg = redactCredentials(String((e as any)?.message ?? e));
      console.warn("syncGlobalVault: pull failed; aborting any in-progress merge", msg);
      try { await git.raw(["merge", "--abort"]); } catch {}
      try { await git.raw(["rebase", "--abort"]); } catch {}
      throw new Error(`Sync failed during pull: ${msg}`);
    }

    if (pullSucceeded) {
      stage("pushing");
      try {
        await git.branch(["-M", "main"]);
        await git.push("origin", "main");
      } catch (error: any) {
        const msg = redactCredentials(String(error?.message ?? error));
        console.error("syncGlobalVault: push failed:", msg);
        throw new Error(`Push failed: ${msg}`);
      }
    }
    stage("done");
  });
}

export async function getGlobalRemote(dataDir: string): Promise<string | null> {
  try {
    const git = gitFor(dataDir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    return origin?.refs.fetch || null;
  } catch (error) {
    return null;
  }
}

export async function setGlobalRemote(dataDir: string, url: string): Promise<void> {
  if (url && !isValidGitRemoteUrl(url)) {
    throw new Error("Invalid remote URL: must be https://, ssh://, git://, or user@host:path");
  }
  // Take the same lock syncBackup uses — otherwise we can swap origin
  // between a sync's pull and push and end up pushing to the wrong remote.
  await withLock(`git:${resolve(dataDir)}`, async () => {
    const git = gitFor(dataDir);
    try {
      await git.status();
    } catch (error) {
      await git.init();
      await git.addConfig("user.email", "kontexta@local");
      await git.addConfig("user.name", "Kontexta");
      await git.addConfig("commit.gpgsign", "false");
      await git.addConfig("tag.gpgsign", "false");
    }

    // Snapshot origin so we can restore it if addRemote fails partway
    // through — otherwise the user is left with no remote configured.
    let previousOriginUrl: string | null = null;
    try {
      const remotes = await git.getRemotes(true);
      previousOriginUrl = remotes.find((r) => r.name === "origin")?.refs.fetch || null;
    } catch {}

    let removed = false;
    try {
      await git.removeRemote("origin");
      removed = true;
    } catch {}

    if (url) {
      try {
        await git.addRemote("origin", url);
      } catch (e: any) {
        if (removed && previousOriginUrl) {
          try { await git.addRemote("origin", previousOriginUrl); } catch {}
        }
        throw new Error(redactCredentials(String(e?.message ?? e)));
      }
    }
  });
}

/**
 * Optional per-stage progress callback. Producers (API routes) wire this to
 * a WS broadcast so the UI can show what git is currently doing.
 */
export type SyncStage =
  | "preparing"
  | "staging local"
  | "committing local"
  | "pulling remote"
  | "merging remote"
  | "pushing"
  | "done";

export async function syncBackup(
  projectId: number,
  dataDir: string,
  onStage?: (stage: SyncStage) => void
): Promise<string[]> {
  // Per-dataDir git lock prevents commitFile from interleaving with the pipeline.
  return await withLock(`git:${resolve(dataDir)}`, () => _syncBackupLocked(projectId, dataDir, onStage));
}

async function _syncBackupLocked(
  projectId: number,
  dataDir: string,
  onStage?: (stage: SyncStage) => void
): Promise<string[]> {
  const stage = (s: SyncStage) => { try { onStage?.(s); } catch {} };
  stage("preparing");
  const db = getDatabase();

  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as ProjectRecord | undefined;
  if (!project) {
    throw new Error(`Project with id ${projectId} not found`);
  }

  const files = db
    .prepare("SELECT * FROM files WHERE project_id = ? AND storage_type = 'reference'")
    .all(projectId) as FileRecord[];

  const copiedPaths: string[] = [];
  const backupDir = join(dataDir, "backups", project.slug);
  mkdirSync(backupDir, { recursive: true });

  const git: SimpleGit = gitFor(dataDir);

  try {
    await git.status();
  } catch {
    await git.init();
    await git.addConfig("user.email", "kontexta@local");
    await git.addConfig("user.name", "Kontexta");
    await git.addConfig("commit.gpgsign", "false");
    await git.addConfig("tag.gpgsign", "false");
  }

  const globalRemoteUrl = await getGlobalRemote(dataDir);
  if (globalRemoteUrl) {
    if (!isValidGitRemoteUrl(globalRemoteUrl)) {
      throw new Error("Configured global remote URL is not a valid git remote");
    }
    try {
      try { await git.removeRemote("origin"); } catch {}
      await git.addRemote("origin", globalRemoteUrl);
      try {
        await git.raw(["rev-parse", "HEAD"]);
      } catch {
        await git.commit("Initial commit", ["--allow-empty"], { "--no-gpg-sign": null });
      }
    } catch (error: any) {
      console.warn("Git remote setup failed:", redactCredentials(String(error?.message ?? error)));
    }
  }

  // Capture HEAD pre-pull so STEP 3 can ask git which files were genuinely
  // deleted upstream (vs inferring deletion from a local-snapshot diff).
  let preHead: string | null = null;
  try {
    preHead = (await git.revparse(["HEAD"])).trim();
  } catch {
    preHead = null;
  }

  // STEP 1 — refresh backup tree from disk. We do NOT rmSync first: a
  // transient EACCES would leave the file absent from the rebuild,
  // `git add -A` would stage it as a deletion, and the next pull would
  // unlink it from the user's source tree (the data-loss path STEP 3's
  // diff guard was meant to prevent). Instead, overwrite in place and
  // only prune orphans when every source file was accounted for.
  stage("staging local");
  const expectedBackupPaths = new Set<string>();
  let copyFailures = 0;

  // Skip the copy phase entirely for projects without a registered path —
  // there's nothing to copy, and locking on `resolve("") === cwd` would
  // collapse every such project onto a shared lock keyed on the CWD.
  // Also skip the inner lock when project.path resolves to dataDir: we
  // already hold `git:${resolve(dataDir)}` (the outer syncBackup lock),
  // and re-entering the same key would deadlock because withLock chains
  // onto the previous tail and that tail can't settle until we return.
  const sameAsDataDir = !!project.path && resolve(project.path) === resolve(dataDir);
  const copyBody = async () => {
    for (const file of files) {
      if (!file.path || !project.path) continue;
      const relativePath = relative(project.path, file.path);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;

      const backupPath = join(backupDir, relativePath);

      if (!existsSync(file.path)) {
        if (existsSync(backupPath)) expectedBackupPaths.add(backupPath);
        continue;
      }

      mkdirSync(dirname(backupPath), { recursive: true });
      try {
        copyFileSync(file.path, backupPath);
        expectedBackupPaths.add(backupPath);
        copiedPaths.push(backupPath);
      } catch (e) {
        console.warn(`syncBackup: failed to copy ${file.path}:`, e);
        copyFailures++;
        if (existsSync(backupPath)) expectedBackupPaths.add(backupPath);
      }
    }
  };
  if (project.path) {
    if (sameAsDataDir) {
      await copyBody();
    } else {
      await withLock(`git:${resolve(project.path)}`, copyBody);
    }
  }

  if (copyFailures === 0) {
    const pruneOrphans = (dir: string): void => {
      if (!existsSync(dir)) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (entry === ".git") continue;
        const fullPath = join(dir, entry);
        let st;
        try { st = statSync(fullPath); } catch { continue; }
        if (st.isDirectory()) {
          pruneOrphans(fullPath);
          try {
            if (readdirSync(fullPath).length === 0) rmSync(fullPath, { recursive: true, force: true });
          } catch {}
        } else if (!expectedBackupPaths.has(fullPath)) {
          try { unlinkSync(fullPath); } catch {}
        }
      }
    };
    pruneOrphans(backupDir);
  } else {
    console.warn(
      `syncBackup: ${copyFailures} source file(s) failed to copy; skipping orphan pruning to avoid propagating phantom deletions`
    );
  }

  const backupRelativeDir = relative(dataDir, backupDir);
  await git.add(["-A", "-f", backupRelativeDir]);

  const status = await git.status();
  if (status.staged.length > 0 || status.created.length > 0 || status.deleted.length > 0 || status.modified.length > 0) {
    stage("committing local");
    await git.commit(`Sync local changes for project: ${project.name}`, [backupRelativeDir], { "--no-verify": null, "--no-gpg-sign": null });
  }

  // STEP 2 — pull remote.
  let pullSucceeded = false;
  if (globalRemoteUrl) {
    stage("pulling remote");
    try {
      await git.pull("origin", "main", { "--rebase": "false" });
      pullSucceeded = true;
      stage("merging remote");
    } catch (e) {
      const msg = redactCredentials(String((e as any)?.message ?? e));
      console.warn("Pull/Merge failed; aborting any in-progress merge and skipping push", msg);
      // Don't leave a half-applied merge in the working tree, and don't
      // proceed to push — pushing now would either reject or silently
      // overwrite the remote with a state that never integrated upstream.
      try { await git.raw(["merge", "--abort"]); } catch {}
      try { await git.raw(["rebase", "--abort"]); } catch {}
      throw new Error(`Sync failed during pull: ${msg}`);
    }
  }

  // STEP 3 — sync merged truth back to local workspace.
  function walkDir(dir: string, fileList: string[] = []) {
    if (!existsSync(dir)) return fileList;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === ".git") continue;
      const fullPath = join(dir, entry);
      // lstatSync to avoid following symlinks — a symlink loop in the
      // backup tree would otherwise recurse forever.
      let st;
      try { st = lstatSync(fullPath); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walkDir(fullPath, fileList);
      } else if (st.isFile()) {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  const mergedFiles = walkDir(backupDir);
  const existingDbPaths = new Set(files.map((f) => f.path));

  for (const backupPath of mergedFiles) {
    // Per-file try/catch — a single bad file (EACCES, transient FS error,
    // huge content, etc.) must not abort the whole merge.
    try {
      const relativePath = relative(backupDir, backupPath);

      if (project.path) {
        const localAbsolutePath = join(project.path, relativePath);
        // Defense-in-depth: never write outside the project dir.
        const projectResolved = resolve(project.path);
        if (resolve(localAbsolutePath) !== projectResolved && !resolve(localAbsolutePath).startsWith(projectResolved + sep)) {
          continue;
        }
        mkdirSync(dirname(localAbsolutePath), { recursive: true });

        // Skip the write when local already matches — avoids mtime bumps
        // that trigger a watcher refresh storm. Warn loudly when local
        // diverged (we still take the merge result as truth).
        let localBuf: Buffer | null = null;
        try { localBuf = readFileSync(localAbsolutePath); } catch {}
        const backupBuf = readFileSync(backupPath);

        if (localBuf?.equals(backupBuf)) {
          // already in sync
        } else {
          if (localBuf) {
            console.warn(
              `syncBackup: overwriting locally-modified ${localAbsolutePath} ` +
                "with merged remote content (use git history if you need to recover)"
            );
          }
          writeFileSync(localAbsolutePath, backupBuf);
        }

        if (!existingDbPaths.has(localAbsolutePath)) {
          const basename = relativePath.split("/").pop() || "";
          const title = stripIndexedExt(basename) || "Untitled";
          const content = readFileSync(localAbsolutePath, "utf-8");
          const contentHash = createHash("sha256").update(content).digest("hex");
          const insertFileStmt = db.prepare(
            "INSERT OR IGNORE INTO files (path, title, project_id, storage_type, content_hash) VALUES (?, ?, ?, ?, ?)"
          );
          const insertFtsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");
          db.transaction(() => {
            const result = insertFileStmt.run(localAbsolutePath, title, project.id, "reference", contentHash);
            if (result.changes > 0) {
              insertFtsStmt.run(result.lastInsertRowid, title, content);
            }
          })();
          copiedPaths.push(localAbsolutePath);
        }
      }
    } catch (e) {
      console.warn(`syncBackup: failed to apply merged file ${backupPath}:`, e);
    }
  }

  // Remote-side deletions: trust git's own diff between preHead and the
  // post-pull HEAD. Inferring from "missing in local snapshot" would
  // unlink files in the user's source tree on any local copy hiccup.
  if (pullSucceeded && preHead && project.path) {
    let postHead: string | null = null;
    try {
      postHead = (await git.revparse(["HEAD"])).trim();
    } catch {
      postHead = null;
    }
    if (postHead && postHead !== preHead) {
      let deletedRel: string[] = [];
      try {
        const out = await git.raw([
          "diff",
          "--name-only",
          "--diff-filter=D",
          `${preHead}..${postHead}`,
          "--",
          backupRelativeDir,
        ]);
        deletedRel = out.split("\n").map((s) => s.trim()).filter(Boolean);
      } catch (e) {
        console.warn("syncBackup: failed to diff for deletions:", e);
      }

      const projectResolved = resolve(project.path);
      for (const repoRel of deletedRel) {
        const insideBackup = relative(backupRelativeDir, repoRel);
        if (insideBackup.startsWith("..") || isAbsolute(insideBackup)) continue;
        const localAbsolutePath = join(project.path, insideBackup);
        const resolvedLocal = resolve(localAbsolutePath);
        if (resolvedLocal !== projectResolved && !resolvedLocal.startsWith(projectResolved + sep)) {
          continue;
        }
        try {
          if (existsSync(localAbsolutePath)) {
            unlinkSync(localAbsolutePath);
          }
        } catch (e) {
          console.warn(`syncBackup: failed to remove ${localAbsolutePath}:`, e);
        }
        const dbRow = db.prepare("SELECT id FROM files WHERE path = ?").get(localAbsolutePath) as { id: number } | undefined;
        if (dbRow) {
          const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
          const deleteFileStmt = db.prepare("DELETE FROM files WHERE id = ?");
          db.transaction(() => {
            deleteFtsStmt.run(dbRow.id);
            deleteFileStmt.run(dbRow.id);
          })();
        }
      }
    }
  }

  // STEP 4 — push.
  if (globalRemoteUrl) {
    stage("pushing");
    try {
      await git.branch(["-M", "main"]);
      await git.push("origin", "main");
    } catch (error: any) {
      const msg = redactCredentials(String(error?.message ?? error));
      console.error("Git push failed:", msg);
      throw new Error(`Git push failed: ${msg}`);
    }
  }

  stage("done");
  return copiedPaths;
}
