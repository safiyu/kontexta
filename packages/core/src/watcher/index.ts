import chokidar, { type FSWatcher } from "chokidar";
import { getDatabase } from "../db/index.js";
import { isIndexedFile, stripIndexedExt } from "../util/extensions.js";
import { withLock, fileLockKey } from "../util/safety.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface WatcherEvent {
  type: "change" | "add" | "unlink";
  path: string;
}

/** True when filePath is exactly under baseDir (not a sibling like /foo vs /foo2). */
function isUnder(filePath: string, baseDir: string): boolean {
  const rel = path.relative(baseDir, filePath);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function createFileWatcher(
  watchPaths: string[],
  onEvent: (event: WatcherEvent) => void
): FSWatcher {
  // Auto-ingest scope: files under <dataDir>/knowledge/ or a registered
  // project. Anything else is ignored (stray files would otherwise be
  // adopted as KB and could then be unlinked from disk on UI delete).
  const knowledgeDirs = watchPaths.map((wp) => path.join(wp, "knowledge"));

  const watcher = chokidar.watch(watchPaths, {
    // Skip the same set discoverFiles skips, plus build-output / cache /
    // virtualenv directories that commonly contain throw-away .md/.mmd files,
    // plus the backup tree owned by syncBackup. The previous regex
    // excluded ANY dot-prefixed segment, which silently dropped all
    // changes under .claude/, .github/, .cursor/ — exactly where
    // AI-context lives. Also ignore the tmp files produced by
    // restoreVersion (`<file>.kontexta-restore-<pid>-<ts>`) so the
    // atomic-rename dance doesn't generate spurious add/unlink events.
    ignored: (p: string) =>
      /[\/\\](node_modules|\.git|\.next|\.nuxt|\.cache|\.venv|\.tox|\.gradle|\.idea|dist|build|out|target)([\/\\]|$)/.test(p) ||
      /[\/\\]backups[\/\\]/.test(p) ||
      /\.kontexta-restore-\d+-\d+$/.test(p),
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  // Per-path lock around every handler so a watcher event fired during a
  // createFile/updateFile (which hold the same key) queues until the
  // in-flight write commits. The handlers themselves no-op when the
  // already-stored hash matches, so the queued run after our own write
  // is a cheap re-check rather than a duplicate UPSERT.
  const runLocked = (filePath: string, fn: () => void): void => {
    void withLock(fileLockKey(filePath), async () => fn()).catch((e) => {
      console.error(`[watcher] locked handler failed for ${filePath}:`, e);
    });
  };

  watcher.on("change", (filePath) => {
    if (!isIndexedFile(filePath)) return;
    runLocked(filePath, () => {
      // If the row was deleted (e.g. via Time-Travel restore of a previously
      // unlinked file) and the file is back on disk, treat the change as an
      // add so FTS gets repopulated instead of silently no-op'ing.
      updateFileHash(filePath, knowledgeDirs);
      onEvent({ type: "change", path: filePath });
    });
  });

  watcher.on("add", (filePath) => {
    if (!isIndexedFile(filePath)) return;
    runLocked(filePath, () => {
      handleWatcherAdd(filePath, knowledgeDirs);
      onEvent({ type: "add", path: filePath });
    });
  });

  watcher.on("unlink", (filePath) => {
    if (!isIndexedFile(filePath)) return;
    runLocked(filePath, () => {
      handleWatcherUnlink(filePath);
      onEvent({ type: "unlink", path: filePath });
    });
  });

  return watcher;
}

function handleWatcherAdd(filePath: string, knowledgeDirs: string[]): void {
  try {
    const db = getDatabase();
    // Check if already in DB
    const existing = db.prepare("SELECT id FROM files WHERE path = ?").get(filePath);
    if (existing) return;

    let projectId: number | null = null;
    const projects = db.prepare("SELECT id, path FROM projects WHERE path IS NOT NULL").all() as { id: number, path: string }[];
    for (const p of projects) {
      if (isUnder(filePath, p.path)) {
        projectId = p.id;
        break;
      }
    }

    const isKnowledge = knowledgeDirs.some((kd) => isUnder(filePath, kd));
    if (projectId === null && !isKnowledge) return;

    const storageType = projectId !== null ? "reference" : "local";

    const content = fs.readFileSync(filePath, "utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const basename = filePath.split(/[/\\]/).pop() || "";
    const title = stripIndexedExt(basename) || "Untitled";

    // OR IGNORE + skip-FTS-on-no-change covers the discoverFiles race.
    const insertStmt = db.prepare(
      "INSERT OR IGNORE INTO files (path, title, project_id, storage_type, content_hash) VALUES (?, ?, ?, ?, ?)"
    );
    const ftsDel = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
    const ftsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");
    db.transaction(() => {
      const result = insertStmt.run(filePath, title, projectId, storageType, hash);
      if (result.changes > 0) {
        // Defensive pre-delete: a stale fts_index row at this rowid (from
        // a crash mid-transaction) would otherwise UNIQUE-fail the insert.
        ftsDel.run(result.lastInsertRowid);
        ftsStmt.run(result.lastInsertRowid, title, content);
      }
    })();
  } catch (e: any) {
    if (e?.message !== "Database not initialized. Call createDatabase() first.") {
      console.error(`[watcher] handleWatcherAdd failed for ${filePath}:`, e);
    }
  }
}

function handleWatcherUnlink(filePath: string): void {
  try {
    const db = getDatabase();
    const file = db.prepare("SELECT id FROM files WHERE path = ?").get(filePath) as { id: number } | undefined;
    if (file) {
      const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
      const deleteFileStmt = db.prepare("DELETE FROM files WHERE id = ?");
      db.transaction(() => {
        deleteFtsStmt.run(file.id);
        deleteFileStmt.run(file.id);
      })();
    }
  } catch (e: any) {
    if (e?.message !== "Database not initialized. Call createDatabase() first.") {
      console.error(`[watcher] handleWatcherUnlink failed for ${filePath}:`, e);
    }
  }
}

function updateFileHash(filePath: string, knowledgeDirs: string[] = []): void {
  try {
    const db = getDatabase();
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const file = db.prepare("SELECT id, title, content_hash FROM files WHERE path = ?").get(filePath) as
      | { id: number; title: string; content_hash: string }
      | undefined;
    if (file) {
      // Short-circuit when the row already reflects this content. Common
      // case: the watcher event was triggered by a createFile/updateFile
      // we just ran — the row is already up to date and rewriting FTS
      // is wasted work plus an extra write-lock acquisition.
      if (file.content_hash === hash) return;
      const updateStmt = db.prepare("UPDATE files SET content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
      const insertFtsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");
      db.transaction(() => {
        updateStmt.run(hash, file.id);
        deleteFtsStmt.run(file.id);
        insertFtsStmt.run(file.id, file.title, content);
      })();
    } else {
      // Row missing — fall back to the add path so a restored file shows up.
      handleWatcherAdd(filePath, knowledgeDirs);
    }
  } catch (e: any) {
    if (e?.message !== "Database not initialized. Call createDatabase() first.") {
      console.error(`[watcher] updateFileHash failed for ${filePath}:`, e);
    }
  }
}
