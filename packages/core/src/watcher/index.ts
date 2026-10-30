import chokidar, { type FSWatcher } from "chokidar";
import { getDatabase } from "../db/index.js";
import { isIndexedFile, stripIndexedExt } from "../util/extensions.js";
import { withLock, fileLockKey } from "../util/safety.js";
import { formatGid } from "../identity/gid.js";
import { getMachineId } from "../identity/machine.js";
import { enqueueOp } from "../storage/outbox.js";
import { inRemoteApply } from "../storage/apply.js";
import { isUnresolvedConflictCopy } from "../storage/conflicts.js";
import { isSyncablePath, toRelPath } from "../storage/paths.js";
import { gidOfRow } from "../storage/gids.js";
import type { Op } from "../storage/op.js";
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

/**
 * Append an external-change op to the outbox — UNLESS we are applying a remote
 * op.
 *
 * Echo suppression, layer 1 (spec 1.4): when a remote op is being applied
 * locally, `applyRemoteOp` runs inside the `applyScope` remote-apply scope and
 * touches files on disk. Chokidar then fires add/change/unlink events for our
 * OWN writes; without this guard those events would enqueue outbound ops that
 * echo back to the server and loop. In that case the watcher handler must still
 * persist to DB + disk but NOT enqueue. On the normal external-change path
 * `inRemoteApply()` is false and the op is appended.
 *
 * (Layer 2, the watcher hash gate, additionally no-ops a change whose content
 * hash already matches the stored row — but only when the remote apply updated
 * the DB hash before writing the file. This scope check is the deterministic
 * half that holds even if the hash gate is raced.)
 *
 * Callers invoke this INSIDE their write transaction so the op commits or rolls
 * back atomically with the write (spec 1.3).
 */
function enqueueWatcherOp(op: Op): void {
  if (inRemoteApply()) return;
  // Files outside the data dir (project repos) never sync.
  const p = (op.payload as { path?: unknown }).path;
  if (op.kind.startsWith("file.") && typeof p === "string" && !isSyncablePath(p)) return;
  enqueueOp(getDatabase(), op);
}

/**
 * Active watchers — registered so a global shutdown can close them all
 * without each caller wiring its own SIGINT handler. Without this, pending
 * chokidar events fired after the DB was torn down, surfacing as
 * "Database not initialized" noise (filtered above) but still leaking FDs
 * and polling intervals.
 */
const _activeWatchers = new Set<FSWatcher>();
let _shutdownHooksRegistered = false;

function registerShutdownHooks() {
  if (_shutdownHooksRegistered) return;
  _shutdownHooksRegistered = true;
  const closeAll = () => {
    for (const w of _activeWatchers) {
      try { void w.close(); } catch {}
    }
    _activeWatchers.clear();
  };
  process.once("beforeExit", closeAll);
  // Don't add SIGINT/SIGTERM here — db/index.ts already owns those and will
  // call closeAllWatchers() via the shutdown chain below if wired in.
}

/** Close every watcher created by createFileWatcher in this process. */
export function closeAllFileWatchers(): Promise<void> {
  const promises: Array<Promise<unknown>> = [];
  for (const w of _activeWatchers) {
    try { promises.push(Promise.resolve(w.close())); } catch {}
  }
  _activeWatchers.clear();
  return Promise.all(promises).then(() => undefined);
}

export function createFileWatcher(
  watchPaths: string[],
  onEvent: (event: WatcherEvent) => void
): FSWatcher {
  registerShutdownHooks();
  // Auto-ingest scope: files under <dataDir>/knowledge/ or a registered
  // project. Anything else is ignored (stray files would otherwise be
  // adopted as KB and could then be unlinked from disk on UI delete).
  const knowledgeDirs = watchPaths.map((wp) => path.join(wp, "knowledge"));

  const watcher: any = chokidar.watch(watchPaths, {
    // Skip the same set discoverFiles skips, plus build-output / cache /
    // virtualenv directories that commonly contain throw-away .md/.mmd files,
    // plus any legacy backups/ tree — historical note: the (now-removed)
    // per-project backup mechanism wrote <dataDir>/backups/<slug> subtrees;
    // that mechanism no longer exists, so we keep ignoring backups/
    // defensively so a stale copy that lingers on disk isn't adopted as KB.
    // The previous
    // regex excluded ANY dot-prefixed segment, which silently dropped all
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

  watcher.on("change", (filePath: string) => {
    if (!isIndexedFile(filePath)) return;
    runLocked(filePath, () => {
      // If the row was deleted (e.g. via Time-Travel restore of a previously
      // unlinked file) and the file is back on disk, treat the change as an
      // add so FTS gets repopulated instead of silently no-op'ing.
      updateFileHash(filePath, knowledgeDirs);
      onEvent({ type: "change", path: filePath });
    });
  });

  watcher.on("add", (filePath: string) => {
    if (!isIndexedFile(filePath)) return;
    runLocked(filePath, () => {
      handleWatcherAdd(filePath, knowledgeDirs);
      onEvent({ type: "add", path: filePath });
    });
  });

  watcher.on("unlink", (filePath: string) => {
    if (!isIndexedFile(filePath)) return;
    runLocked(filePath, () => {
      handleWatcherUnlink(filePath);
      onEvent({ type: "unlink", path: filePath });
    });
  });

  _activeWatchers.add(watcher);
  // Auto-deregister on close so the set doesn't leak references.
  const origClose = watcher.close.bind(watcher);
  watcher.close = (() => {
    _activeWatchers.delete(watcher);
    return origClose();
  }) as typeof watcher.close;
  return watcher;
}

export function handleWatcherAdd(filePath: string, knowledgeDirs: string[]): void {
  try {
    const db = getDatabase();
    if (isUnresolvedConflictCopy(db, filePath)) return;
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
        // A genuine insert (OR IGNORE reports changes > 0 only on a fresh row)
        // gets a local gid = <id>@<machine_id>, matching the migration-013
        // backfill and the other on-insert write routines.
        const newId = Number(result.lastInsertRowid);
        db.prepare("UPDATE files SET gid = ? WHERE id = ?").run(
          formatGid(newId, getMachineId()),
          newId,
        );
        // An externally-dropped file is a create from this machine's point of
        // view. Enqueue the op atomically with the insert (spec 1.3); no-op
        // while applying a remote op (echo suppression, spec 1.4). Read the
        // committed row back so the payload carries the exact stored values
        // (gid, content_class, source_path) rather than assumptions.
        const row = db
          .prepare(
            "SELECT gid, content_class, source_path FROM files WHERE id = ?",
          )
          .get(newId) as { gid: string | null; content_class: string | null; source_path: string | null } | undefined;
        if (row?.gid) {
          enqueueWatcherOp({
            gid: row.gid,
            kind: "file.create",
            origin: getMachineId(),
            base_version: null,
            payload: {
              path: filePath,
              rel_path: toRelPath(filePath) ?? undefined,
              title,
              project_gid: gidOfRow("projects", projectId),
              storage_type: storageType,
              content_class: row.content_class ?? null,
              source_path: row.source_path ?? null,
              content,
              content_hash: hash,
            },
            created_at: Date.now(),
          });
        }
      }
    })();
  } catch (e: any) {
    if (e?.message !== "Database not initialized. Call createDatabase() first.") {
      console.error(`[watcher] handleWatcherAdd failed for ${filePath}:`, e);
    }
  }
}

export function handleWatcherUnlink(filePath: string): void {
  try {
    const db = getDatabase();
    const file = db
      .prepare("SELECT id, gid FROM files WHERE path = ?")
      .get(filePath) as { id: number; gid: string | null } | undefined;
    if (file) {
      // Read the record's gid (not recomputed) so a REMOTE file's deletion
      // carries the correct identity. Fall back to the local gid if the row
      // pre-dates the migration-013 backfill.
      const gid = file.gid ?? formatGid(file.id, getMachineId());
      const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
      const deleteFileStmt = db.prepare("DELETE FROM files WHERE id = ?");
      db.transaction(() => {
        // Enqueue the outbound op atomically with the write (spec 1.3); no-op
        // while applying a remote op (echo suppression, spec 1.4). The op is
        // appended before the DELETE so a rolled-back transaction discards it.
        enqueueWatcherOp({
          gid,
          kind: "file.delete",
          origin: getMachineId(),
          base_version: 0,
          payload: { path: filePath, rel_path: toRelPath(filePath) ?? undefined },
          created_at: Date.now(),
        });
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

export function updateFileHash(filePath: string, knowledgeDirs: string[] = []): void {
  try {
    const db = getDatabase();
    if (isUnresolvedConflictCopy(db, filePath)) return;
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const file = db
      .prepare("SELECT id, title, content_hash, gid FROM files WHERE path = ?")
      .get(filePath) as
      | { id: number; title: string; content_hash: string; gid: string | null }
      | undefined;
    if (file) {
      // Short-circuit when the row already reflects this content. Common
      // case: the watcher event was triggered by a createFile/updateFile
      // we just ran — the row is already up to date and rewriting FTS
      // is wasted work plus an extra write-lock acquisition. No hash change,
      // so no outbound op either (this is the watcher hash gate, spec 1.4).
      if (file.content_hash === hash) return;
      // Read the record's gid (not recomputed) so a REMOTE file's external
      // edit carries the correct identity. Fall back to the local gid if the
      // row pre-dates the migration-013 backfill.
      const gid = file.gid ?? formatGid(file.id, getMachineId());
      const updateStmt = db.prepare("UPDATE files SET content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
      const insertFtsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");
      db.transaction(() => {
        updateStmt.run(hash, file.id);
        deleteFtsStmt.run(file.id);
        insertFtsStmt.run(file.id, file.title, content);
        // A genuine external edit (the stored hash changed) is an update from
        // this machine's point of view. Enqueue the op atomically with the
        // write (spec 1.3); no-op while applying a remote op (echo
        // suppression, spec 1.4).
        enqueueWatcherOp({
          gid,
          kind: "file.update",
          origin: getMachineId(),
          base_version: 0,
          payload: {
            path: filePath,
            rel_path: toRelPath(filePath) ?? undefined,
            title: file.title,
            content,
            content_hash: hash,
          },
          created_at: Date.now(),
        });
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
