/**
 * Git operations module for Kontexta
 * Handles commit, history, diff, restore, and vault sync operations
 */

import { createHash } from "node:crypto";
import simpleGit, { SimpleGit, LogResult } from "simple-git";
import { writeFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { getDatabase } from "../db/index.js";
import { withLock } from "../util/safety.js";

/** Git tree paths always use forward slashes, regardless of host OS. */
const toGitPath = (p: string): string => p.split(sep).join("/");

// Strip env that would let git spawn an editor/pager/credential helper —
// any of those would hang a server-side request. Also strips vars that could
// redirect git operations (SSH commands, exec paths, external diffs).
function buildGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Skip system and global gitconfig so CI runners with inaccessible
    // ~/.gitconfig (e.g. Windows GitHub Actions) don't blow up.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: platform() === "win32" ? "NUL" : "/dev/null",
  };
  for (const k of [
    "PAGER", "EDITOR", "VISUAL",
    "GIT_EDITOR", "GIT_PAGER", "GIT_SEQUENCE_EDITOR",
    "GIT_ASKPASS", "SSH_ASKPASS",
    "GIT_PROXY_COMMAND", "GIT_HTTP_USER_AGENT", "GIT_EXTERNAL_DIFF",
    // Prevent SSH/command redirection
    "GIT_SSH", "GIT_SSH_COMMAND",
    // Prevent exec path manipulation
    "GIT_EXEC_PATH",
    // Prevent credential helper injection
    "GIT_CONFIG_COUNT", // clears GIT_CONFIG_COUNT + GIT_CONFIG_KEY_N/VALUE_N pairs
    // Prevent trace logs from leaking sensitive data (and from being a side-channel).
    "GIT_TRACE", "GIT_TRACE_PACK_ACCESS", "GIT_TRACE_PACKET",
    "GIT_TRACE_PERFORMANCE", "GIT_TRACE_SETUP", "GIT_TRACE_CURL",
  ]) {
    delete env[k];
  }
  return env;
}

function gitFor(dir: string): SimpleGit {
  // allowUnsafeConfigPaths is required so simple-git's security plugin permits
  // GIT_CONFIG_GLOBAL pointing to /dev/null (Linux) or NUL (Windows) — the
  // paths we use in buildGitEnv() to isolate git from inaccessible runner configs.
  return simpleGit(dir, { unsafe: { allowUnsafeConfigPaths: true } }).env(buildGitEnv() as any);
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
    const relativePath = toGitPath(relative(repoDir, filePath));
    await git.add(["-f", relativePath]);
    // Path-scoped commit so concurrent activity in the repo can't get swept in.
    await git.commit(message, [relativePath], { "--no-verify": null, "--no-gpg-sign": null });
  });
}

/**
 * Record a file deletion in git: `git rm -f <path>` + commit.
 *
 * Symmetric with `commitFile` — without this, deleteFile() unlinks the file
 * from disk but git still has it in HEAD. Any subsequent operation that
 * touches the working tree (a manual
 * `git restore`, a stash pop) resurrects the file, and the watcher's `add`
 * handler then re-indexes it as a new row, making it look like delete
 * silently "came back".
 *
 * Best-effort: if the file isn't in git (untracked) or git fails, we swallow
 * the error rather than block the delete. The DB/disk delete already
 * succeeded — leaving an uncommitted delete in the working tree is better
 * than failing the user's delete action.
 */
export async function commitDelete(
  repoDir: string,
  filePath: string,
  message: string,
): Promise<void> {
  await withLock(`git:${resolve(repoDir)}`, async () => {
    try {
      await ensureGitRepo(repoDir);
      const git: SimpleGit = gitFor(repoDir);
      const relativePath = toGitPath(relative(repoDir, filePath));
      // Use `git rm -f --ignore-unmatch` so it's a no-op when the path was
      // never tracked. --cached would only update the index; we want both
      // index AND remove-from-working-tree-if-still-there.
      try {
        await git.raw(["rm", "-f", "--ignore-unmatch", "--", relativePath]);
      } catch (rmErr) {
        // Even if `git rm` itself errors, fall through to commit attempt —
        // the disk file is already gone, so `git status` should still see
        // the deletion.
        console.warn(`commitDelete: git rm failed for ${relativePath}:`, (rmErr as Error).message);
      }
      // Commit the deletion, scoped to this path. `--allow-empty` so we
      // don't bomb when the file wasn't tracked at all (nothing staged).
      try {
        await git.commit(message, [relativePath], {
          "--no-verify": null,
          "--no-gpg-sign": null,
          "--allow-empty": null,
        });
      } catch (commitErr) {
        console.warn(`commitDelete: git commit failed for ${relativePath}:`, (commitErr as Error).message);
      }
    } catch (e) {
      console.warn(`commitDelete: failed for ${filePath}:`, (e as Error).message);
    }
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
  const relativePath = toGitPath(relative(repoDir, filePath));

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
  const relativePath = toGitPath(relative(repoDir, filePath));

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
    const relativePath = toGitPath(relative(repoDir, filePath));

    // Reject anything that doesn't look like a hex commit hash (or a
    // strict short hash). HEAD~N / branch names / arbitrary revspecs are
    // intentionally NOT allowed via this entry point — restoreVersion is
    // meant for points reachable via getHistory(), all of which return
    // full SHAs. A value beginning with `-` would otherwise be parsed by
    // git as a flag.
    if (!/^[A-Fa-f0-9]{4,64}$/.test(commitHash)) {
      throw new Error(`restoreVersion: commitHash must be a hex SHA, got: ${JSON.stringify(commitHash)}`);
    }

    // cat-file (not simple-git's `show`) so non-utf-8 bytes survive intact.
    // The `--` separator forces git to treat the next token as a positional,
    // not a flag — defense-in-depth on top of the hex-only validation above.
    const result = spawnSync(
      "git",
      ["-C", repoDir, "cat-file", "-p", "--", `${commitHash}:${relativePath}`],
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
    writeFileSync(tmpPath, contentBuffer as any);
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
      const hash = createHash("sha256").update(contentBuffer as any).digest("hex");
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
