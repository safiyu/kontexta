/**
 * Metadata operations module for Kontexta
 * Handles tags, favorites, search, project registration, and file discovery
 */

import { readdirSync, lstatSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getDatabase } from "../db/index.js";
import { withLock } from "../util/safety.js";
import type { TagRecord, ProjectRecord, FileRecord, SearchFilters } from "../types.js";
import { computeHash } from "../files/index.js";
import { isIndexedFile, stripIndexedExt } from "../util/extensions.js";
import { getDataDir } from "../util/paths.js";
import { syncProjectsSidecarIfStaged } from "../hooks/stage.js";
import { formatGid } from "../identity/gid.js";
import { getMachineId } from "../identity/machine.js";
import { enqueueOp } from "../storage/outbox.js";
import { inRemoteApply } from "../storage/apply.js";
import type { Op } from "../storage/op.js";

export interface FileRecordWithRank extends FileRecord {
  rank: number;
  /**
   * FTS5 snippet around the matched terms in `content`. Hits are wrapped in
   * `<<<…>>>` markers; boundaries elided with `…`. Lets agents see WHERE the
   * match was without re-reading the whole file.
   */
  match_excerpt: string | null;
  /**
   * Full title with `<<<…>>>` markers around the matched terms. Useful when
   * the hit was in the title (snippet on title would just return the whole
   * thing anyway, so highlight is more informative).
   */
  title_highlight: string | null;
}

export interface RelatedFileRecord extends FileRecord {
  shared_tag_count: number;
  shared_tags: string[];
}

export function findRelated(fileId: number, limit: number = 10): RelatedFileRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
      SELECT
        f.*,
        COUNT(ft2.tag_id) AS shared_tag_count,
        GROUP_CONCAT(t.name) AS shared_tags_csv
      FROM file_tags ft1
      JOIN file_tags ft2 ON ft1.tag_id = ft2.tag_id
      JOIN files f ON f.id = ft2.file_id
      JOIN tags t ON t.id = ft2.tag_id
      WHERE ft1.file_id = ?
        AND ft2.file_id != ?
      GROUP BY f.id
      ORDER BY shared_tag_count DESC, f.updated_at DESC
      LIMIT ?
      `
    )
    .all(fileId, fileId, limit) as Array<FileRecord & { shared_tag_count: number; shared_tags_csv: string }>;

  return rows.map(({ shared_tags_csv, ...rest }) => ({
    ...rest,
    shared_tags: shared_tags_csv ? shared_tags_csv.split(",") : [],
  }));
}

/**
 * Convert name to slug (lowercase, alphanumeric with dashes)
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Append a metadata-mutation op to the outbox — UNLESS we are applying a
 * remote op.
 *
 * Echo suppression, layer 1 (spec 1.4): when a remote op is being applied
 * locally, `applyRemoteOp` runs inside the `applyScope` remote-apply scope. In
 * that case the write routine must persist to DB but NOT enqueue an outbound
 * op (or the change would echo back to the server and loop). On the normal
 * local-write path `inRemoteApply()` is false and the op is appended.
 *
 * Callers invoke this INSIDE their write transaction so the op commits or rolls
 * back atomically with the write (spec 1.3). Mirrors the files module's
 * `enqueueFileOp` (M54).
 */
function enqueueMetadataOp(op: Op): void {
  if (inRemoteApply()) return;
  enqueueOp(getDatabase(), op);
}

/**
 * The global id of the file row `fileId` — read from the row, not recomputed.
 * A locally-edited REMOTE file keeps its remote origin in the gid, so the
 * outbound op must carry that identity. Falls back to the local gid if the row
 * pre-dates migration 013 (no gid stamped).
 */
function fileGid(fileId: number): string {
  const db = getDatabase();
  const row = db.prepare("SELECT gid FROM files WHERE id = ?").get(fileId) as
    | { gid: string | null }
    | undefined;
  return row?.gid ?? formatGid(fileId, getMachineId());
}

/**
 * Add tags to a file
 */
export function addTags(fileId: number, tagNames: string[]): void {
  const db = getDatabase();

  const insertTagStmt = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const getTagStmt = db.prepare("SELECT id FROM tags WHERE name = ?");
  const linkTagStmt = db.prepare("INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)");
  // gid depends on the auto-generated integer PK, so it is stamped via UPDATE
  // inside the same transaction (matching the migration-013 backfill convention).
  const setTagGidStmt = db.prepare("UPDATE tags SET gid = ? WHERE id = ?");

  db.transaction(() => {
    // Track the tag names actually linked so the op carries the global identity
    // (names, not machine-local tag ids) of what changed on this file.
    const linkedTags: string[] = [];
    for (const tagName of tagNames) {
      const inserted = insertTagStmt.run(tagName);
      const tag = getTagStmt.get(tagName) as { id: number } | undefined;
      if (!tag) continue;
      // Assign the global id now that the integer PK is known. Only on a fresh
      // insert: INSERT OR IGNORE reports 0 changes for a pre-existing tag, whose
      // gid the migration-013 backfill (or an earlier insert) already set.
      if (inserted.changes > 0) {
        setTagGidStmt.run(formatGid(tag.id, getMachineId()), tag.id);
      }
      linkTagStmt.run(fileId, tag.id);
      linkedTags.push(tagName);
    }

    // Enqueue the outbound op atomically with the write (spec 1.3); no-op while
    // applying a remote op (echo suppression, spec 1.4). The op is keyed by the
    // FILE's gid (file_tags has no gid of its own) so a receiving machine can
    // re-apply "these tags on that file".
    if (linkedTags.length > 0) {
      enqueueMetadataOp({
        gid: fileGid(fileId),
        kind: "tag.add",
        origin: getMachineId(),
        base_version: 0,
        payload: { file_id: fileId, tags: linkedTags },
        created_at: Date.now(),
      });
    }
  })();
}

/**
 * Remove tags from a file
 */
export function removeTags(fileId: number, tagIds: number[]): void {
  const db = getDatabase();

  const deleteStmt = db.prepare("DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?");

  db.transaction(() => {
    // Track the tags actually removed (0 changes means the file wasn't linked
    // to that tag) so the op reflects only real changes.
    const removedTagIds: number[] = [];
    for (const tagId of tagIds) {
      const r = deleteStmt.run(fileId, tagId);
      if (r.changes > 0) removedTagIds.push(tagId);
    }

    // Enqueue atomically with the write (spec 1.3); no-op while applying a
    // remote op (echo suppression, spec 1.4). Keyed by the FILE's gid, carrying
    // tag names (the global identity) so a receiving machine can re-apply "drop
    // these tags from that file".
    if (removedTagIds.length > 0) {
      const ph = removedTagIds.map(() => "?").join(", ");
      const names = db
        .prepare(`SELECT id, name FROM tags WHERE id IN (${ph})`)
        .all(...removedTagIds) as { id: number; name: string }[];
      const removedTags = names.map((n) => n.name);
      enqueueMetadataOp({
        gid: fileGid(fileId),
        kind: "tag.remove",
        origin: getMachineId(),
        base_version: 0,
        payload: { file_id: fileId, tags: removedTags },
        created_at: Date.now(),
      });
    }
  })();
}

/**
 * Set or unset a file as favorite
 */
export function setFavorite(fileId: number, favorite: boolean): void {
  const db = getDatabase();

  db.transaction(() => {
    if (favorite) {
      const insertStmt = db.prepare("INSERT OR IGNORE INTO favorites (file_id) VALUES (?)");
      insertStmt.run(fileId);
    } else {
      const deleteStmt = db.prepare("DELETE FROM favorites WHERE file_id = ?");
      deleteStmt.run(fileId);
    }

    // Enqueue atomically with the write (spec 1.3); no-op while applying a
    // remote op (echo suppression, spec 1.4). Keyed by the FILE's gid (the
    // favorites table has no gid of its own).
    enqueueMetadataOp({
      gid: fileGid(fileId),
      kind: "favorite.set",
      origin: getMachineId(),
      base_version: 0,
      payload: { file_id: fileId, favorite },
      created_at: Date.now(),
    });
  })();
}

/**
 * Search files using FTS5 with optional filters
 */
export class FtsQueryError extends Error {
  code = "FTS_PARSE" as const;
  constructor(message: string) { super(message); this.name = "FtsQueryError"; }
}

export function search(filters: SearchFilters): FileRecordWithRank[] {
  const db = getDatabase();
  if (typeof filters.query !== "string" || filters.query.trim().length === 0) {
    throw new FtsQueryError("query must be a non-empty string");
  }

  // snippet(fts_index, 1, ...) targets the `content` column (column 1; title
  // is column 0). Markers are agent-parsable triple-bracket pairs that are
  // unlikely to collide with real markdown content.
  let sql = `
    SELECT files.*,
           fts_index.rank,
           snippet(fts_index, 1, '<<<', '>>>', '…', 16) AS match_excerpt,
           highlight(fts_index, 0, '<<<', '>>>') AS title_highlight
    FROM fts_index
    JOIN files ON files.id = fts_index.rowid
    WHERE fts_index MATCH ?
  `;
  const params: any[] = [filters.query];

  if (filters.project_id !== undefined) {
    if (filters.project_id === null) {
      sql += " AND files.project_id IS NULL";
    } else {
      sql += " AND files.project_id = ?";
      params.push(filters.project_id);
    }
  }

  if (filters.favorite !== undefined && filters.favorite) {
    sql += " AND EXISTS (SELECT 1 FROM favorites WHERE favorites.file_id = files.id)";
  }

  if (filters.tags !== undefined && filters.tags.length > 0) {
    // All tags must be present (AND condition)
    for (const tag of filters.tags) {
      sql += ` AND EXISTS (
        SELECT 1 FROM file_tags
        JOIN tags ON tags.id = file_tags.tag_id
        WHERE file_tags.file_id = files.id AND tags.name = ?
      )`;
      params.push(tag);
    }
  }

  if (filters.content_class !== undefined) {
    if (filters.content_class === null) {
      sql += " AND files.content_class IS NULL";
    } else {
      sql += " AND files.content_class = ?";
      params.push(filters.content_class);
    }
  }

  // Dictionary-wins ordering: authoritative KB hits sort above everything
  // else regardless of BM25 rank; then FTS rank; then files.id tiebreak.
  // When raw_bm25_order is true, skip reordering and use raw BM25 rank.
  const limit = Number.isInteger(filters.limit) && (filters.limit as number) > 0
    ? Math.min(filters.limit as number, 1000)
    : 50;
  if (filters.raw_bm25_order) {
    // Raw BM25 order — no dictionary boost, unbiased candidate pool
    sql += ` ORDER BY rank, files.id LIMIT ${limit}`;
  } else {
    // Dictionary-wins ordering: authoritative KB hits sort above everything
    // else regardless of BM25 rank; then FTS rank; then files.id tiebreak.
    sql += ` ORDER BY (files.content_class = 'dictionary') DESC, rank, files.id LIMIT ${limit}`;
  }

  const stmt = db.prepare(sql);
  try {
    return stmt.all(...params) as FileRecordWithRank[];
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/fts5|MATCH|malformed/i.test(msg)) {
      throw new FtsQueryError(`Invalid search query: ${msg}`);
    }
    throw e;
  }
}

/**
 * Register a new project
 */
export function registerProject(
  name: string,
  path: string,
  description?: string,
  remoteUrl?: string
): ProjectRecord & { newlyIndexed: number } {
  const db = getDatabase();

  const slug = slugify(name);
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO projects (name, slug, path, description, remote_url)
    VALUES (?, ?, ?, ?, ?)
  `);
  // gid depends on the auto-generated integer PK, so it is stamped via UPDATE
  // inside the same transaction (matching the migration-013 backfill convention).
  const setGidStmt = db.prepare("UPDATE projects SET gid = ? WHERE id = ?");

  const absolutePath = resolve(path);
  const result = db.transaction(() => {
    const r = insertStmt.run(name, slug, absolutePath, description || null, remoteUrl || null);
    if (r.changes > 0) {
      // Assign the global id now that the integer PK is known. Done in-
      // transaction so the row is never committed with a NULL gid.
      const id = Number(r.lastInsertRowid);
      const gid = formatGid(id, getMachineId());
      setGidStmt.run(gid, id);

      // Enqueue the registration atomically with the insert (spec 1.3); no-op
      // while applying a remote op (echo suppression, spec 1.4). base_version is
      // null for a create (no prior version to base against).
      enqueueMetadataOp({
        gid,
        kind: "project.register",
        origin: getMachineId(),
        base_version: null,
        payload: {
          name,
          slug,
          path: absolutePath,
          description: description || null,
          remote_url: remoteUrl || null,
        },
        created_at: Date.now(),
      });
    }
    return r;
  })();

  let projectId: number;

  if (result.changes > 0) {
    projectId = Number(result.lastInsertRowid);
  } else {
    // INSERT was ignored — either name OR slug already exists. Look both up so
    // we can give a precise error when the *path* conflicts with the existing
    // row, vs. silently returning a stale record under a different path.
    const byName = db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRecord | undefined;
    const bySlug = db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRecord | undefined;
    const existing = byName ?? bySlug;
    if (!existing) {
      // Should be unreachable: INSERT was ignored but neither name nor slug matches.
      throw new Error(`registerProject: insert ignored but no matching project found for name='${name}'`);
    }
    if (existing.path === null) {
      // Synthetic project (auto-provisioned by the journal distillation
      // engine for an orphan slug) — promote it in place instead of
      // throwing, so journal entries already keyed to this project_id
      // stay linked to the same row. A name collision here is structurally
      // unreachable: if another row already held `name`, the byName lookup
      // above would have resolved `existing` to THAT row instead (and, if
      // its path is non-null, we'd already be in the PROJECT_CONFLICT
      // branch below) — so this UPDATE can never violate the name UNIQUE
      // constraint.
      db.transaction(() => {
        db.prepare(
          `UPDATE projects SET name = ?, path = ?, description = ?, remote_url = ? WHERE id = ?`
        ).run(name, absolutePath, description || null, remoteUrl || null, existing.id);
        // Promoting a synthetic row is a real mutation of a syncable projects
        // row — enqueue it (re-assertion, base_version 0) so the promotion
        // converges on other machines rather than silently diverging.
        enqueueMetadataOp({
          gid: existing.gid ?? formatGid(existing.id, getMachineId()),
          kind: "project.register",
          origin: getMachineId(),
          base_version: 0,
          payload: {
            name,
            slug: existing.slug,
            path: absolutePath,
            description: description || null,
            remote_url: remoteUrl || null,
          },
          created_at: Date.now(),
        });
      })();
      projectId = existing.id;
    } else if (existing.path !== absolutePath) {
      const conflicts: string[] = [];
      if (byName) conflicts.push(`name conflicts with '${byName.name}' at '${byName.path}'`);
      if (bySlug && bySlug.id !== byName?.id) conflicts.push(`slug '${slug}' conflicts with '${bySlug.name}' at '${bySlug.path}'`);
      const err = new Error(
        `Cannot register '${name}' at '${path}': ${conflicts.join("; ")}. ` +
        `Pick a different name or unregister the existing project first.`
      );
      (err as any).code = "PROJECT_CONFLICT";
      throw err;
    } else {
      projectId = existing.id;
    }
  }

  // Auto-discover and index files in the project directory.
  const newlyIndexed = reconcileIndex({ projectId, dataDir: getDataDir() }).newRecords.length;

  try { syncProjectsSidecarIfStaged(getDataDir()); } catch { /* sidecar is best-effort; hooks fall back to slug "default" */ }

  return {
    ...(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRecord),
    newlyIndexed,
  };
}

/**
 * Unregister a project and remove all its file metadata
 */
export function unregisterProject(projectId: number, dataDir?: string): void {
  const db = getDatabase();

  // Capture slug + gid before deleting the row — slug is needed for backup
  // subtree cleanup below; gid identifies the unregistration in the outbox.
  const project = db.prepare("SELECT slug, gid FROM projects WHERE id = ?").get(projectId) as
    | { slug: string; gid: string | null }
    | undefined;

  const projectGid = project?.gid ?? formatGid(projectId, getMachineId());

  db.transaction(() => {
    // Journal task files are KB files (no project_id), so they no longer cascade this away; journal_meta still points at the project.
    db.prepare("DELETE FROM journal_meta WHERE project_id = ?").run(projectId);
    const files = db.prepare("SELECT id FROM files WHERE project_id = ?").all(projectId) as { id: number }[];
    const fileIds = files.map(f => f.id);

    if (fileIds.length > 0) {
      const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
      for (const id of fileIds) {
        deleteFtsStmt.run(id);
      }
      // CASCADE on the files DELETE handles file_tags + favorites.
      db.prepare("DELETE FROM files WHERE project_id = ?").run(projectId);
    }

    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);

    // Enqueue the unregistration atomically with the write (spec 1.3); no-op
    // while applying a remote op (echo suppression, spec 1.4).
    enqueueMetadataOp({
      gid: projectGid,
      kind: "project.unregister",
      origin: getMachineId(),
      base_version: 0,
      payload: { project_id: projectId, slug: project?.slug ?? null },
      created_at: Date.now(),
    });
  })();

  try { syncProjectsSidecarIfStaged(getDataDir()); } catch { /* sidecar is best-effort; hooks fall back to slug "default" */ }

  if (dataDir && project?.slug) {
    const backupSubtree = join(dataDir, "backups", project.slug);
    try {
      if (existsSync(backupSubtree)) {
        rmSync(backupSubtree, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn("unregisterProject: failed to remove backup subtree:", e);
    }
  }
}

// Cap size to keep huge files from blowing up memory and the FTS index.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

// Keep this aligned with the chokidar `ignored` regex in watcher/index.ts.
const SKIP_DIRS = new Set([
  "node_modules", ".git",
  ".next", ".nuxt", ".cache", ".venv", ".tox", ".gradle", ".idea",
  "dist", "build", "out", "target",
]);

interface ReconcileOptions {
  /** Project id for project-scoped reconcile, or null for the knowledge base. */
  projectId: number | null;
  /** Data dir; only used to locate the KB when projectId is null. */
  dataDir: string;
}

interface ReconcileResult {
  scope: string;
  newly_indexed: number;
  refreshed: number;
  pruned: number;
  /** Records inserted on this run — used by the discoverFiles wrapper. */
  newRecords: FileRecord[];
  note?: string;
}

/**
 * Single reconciliation loop used by both discoverFiles (project register/refresh
 * UX) and refreshIndex (full re-scan including prune). Walks the on-disk tree,
 * inserts new .md files, re-FTS-indexes ones whose content hash drifted, and
 * prunes DB rows for files no longer on disk.
 *
 * Safety: prune only runs when the top-level readdir succeeded. A transient
 * EACCES on the project/KB root would otherwise leave `onDisk` empty and
 * delete every row for that scope.
 */
function reconcileIndex(opts: ReconcileOptions): ReconcileResult {
  const db = getDatabase();
  const { projectId, dataDir } = opts;

  let root: string;
  let scope: string;
  let dbFilter: string;
  let dbParams: any[];
  let storageType: "reference" | "local";

  if (typeof projectId === "number") {
    const project = db
      .prepare("SELECT id, path FROM projects WHERE id = ?")
      .get(projectId) as { id: number; path: string | null } | undefined;
    if (!project?.path) {
      throw new Error(`Project not found or has no path: ${projectId}`);
    }
    root = project.path;
    scope = `project:${projectId}`;
    dbFilter = "project_id = ?";
    dbParams = [projectId];
    storageType = "reference";
  } else {
    root = join(dataDir, "knowledge");
    scope = "knowledge_base";
    dbFilter = "project_id IS NULL";
    dbParams = [];
    storageType = "local";
    if (!existsSync(root)) {
      return {
        scope,
        newly_indexed: 0,
        refreshed: 0,
        pruned: 0,
        newRecords: [],
        note: "knowledge/ does not exist",
      };
    }
  }

  // Bulk-fetch existing rows once. Includes content_hash so we don't need a
  // per-file SELECT in the walk loop.
  const existingRows = db
    .prepare(`SELECT id, path, content_hash FROM files WHERE ${dbFilter}`)
    .all(...dbParams) as { id: number; path: string; content_hash: string }[];
  const existingByPath = new Map(existingRows.map((r) => [r.path, r] as const));

  const onDisk = new Set<string>();
  let topLevelWalkOk = false;

  function walk(dir: string, isTopLevel = false): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
      if (isTopLevel) topLevelWalkOk = true;
    } catch (e) {
      if (isTopLevel) {
        if (typeof projectId === "number") {
          if ((e as any)?.code === "ENOENT") {
            // Directory doesn't exist yet — treat as empty, not a fatal error.
            // The project may have just been registered before its path was created.
            console.warn(`reconcileIndex: project root does not exist yet: ${dir}`);
          } else {
            // Surface real IO errors (EACCES, etc.) — clear config error.
            throw new Error(`Failed to read project root ${dir}: ${(e as any)?.message ?? e}`);
          }
        } else {
          // KB scope: log and bail. The caller (and the topLevelWalkOk guard
          // below) ensures we don't prune away the entire knowledge base on a
          // transient EACCES.
          console.warn(`reconcileIndex: failed to read KB root ${dir}: ${(e as any)?.message ?? e}`);
        }
      }
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        walk(full, false);
      } else if (st.isFile() && isIndexedFile(entry)) {
        if (st.size > MAX_FILE_BYTES) {
          console.warn(`reconcileIndex: skipping ${full} (size ${st.size} > ${MAX_FILE_BYTES})`);
          continue;
        }
        onDisk.add(full);
      }
    }
  }
  walk(root, true);

  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO files (path, title, project_id, storage_type, content_hash) VALUES (?, ?, ?, ?, ?)"
  );
  const updateStmt = db.prepare(
    "UPDATE files SET content_hash = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const ftsDelete = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
  const ftsInsert = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");
  const fileDelete = db.prepare("DELETE FROM files WHERE id = ?");
  const selectFileById = db.prepare("SELECT * FROM files WHERE id = ?");

  let newly_indexed = 0;
  let refreshed = 0;
  const newRecords: FileRecord[] = [];

  // Read disk content OUTSIDE the SQLite write transaction and apply in
  // bounded chunks. The previous implementation held an exclusive write
  // lock for the entire scan — on a multi-thousand-file project that
  // starved every other DB consumer (watcher, search) until reconcile
  // finished. Per-chunk txns keep each lock-hold short while still
  // amortising BEGIN/COMMIT overhead across many files.
  const RECONCILE_CHUNK = 200;
  const allPaths = Array.from(onDisk);
  for (let chunkStart = 0; chunkStart < allPaths.length; chunkStart += RECONCILE_CHUNK) {
    const chunk = allPaths.slice(chunkStart, chunkStart + RECONCILE_CHUNK);
    const reads: { path: string; content: string; hash: string; title: string }[] = [];
    for (const path of chunk) {
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch (e: any) {
        console.error(`reconcileIndex: failed to read ${path}: ${e?.message ?? e}`);
        continue;
      }
      reads.push({
        path,
        content,
        hash: computeHash(content),
        title: stripIndexedExt(basename(path)),
      });
    }
    db.transaction(() => {
      for (const r of reads) {
        const existing = existingByPath.get(r.path);
        if (!existing) {
          const result = insertStmt.run(r.path, r.title, projectId, storageType, r.hash);
          if (result.changes > 0) {
            const fileId = Number(result.lastInsertRowid);
            // Defensive ftsDelete: guards against orphan FTS rows from a reused
            // rowid if any historical delete path skipped FTS cleanup.
            ftsDelete.run(fileId);
            ftsInsert.run(fileId, r.title, r.content);
            newly_indexed++;
            const rec = selectFileById.get(fileId) as FileRecord | undefined;
            if (rec) newRecords.push(rec);
          }
        } else if (existing.content_hash !== r.hash) {
          updateStmt.run(r.hash, existing.id);
          ftsDelete.run(existing.id);
          ftsInsert.run(existing.id, r.title, r.content);
          refreshed++;
        }
      }
    })();
  }

  // Prune rows for files no longer on disk. Critical: only run if the
  // top-level walk succeeded — otherwise a transient EACCES wipes the index.
  let pruned = 0;
  if (topLevelWalkOk) {
    db.transaction(() => {
      for (const r of existingRows) {
        if (!onDisk.has(r.path)) {
          ftsDelete.run(r.id);
          fileDelete.run(r.id);
          pruned++;
        }
      }
    })();
  }

  return { scope, newly_indexed, refreshed, pruned, newRecords };
}

/**
 * Discover markdown files in a project's external path.
 * Thin wrapper over reconcileIndex; returns the FileRecord[] for newly-inserted
 * files (callers like /api/projects use this to surface "X files indexed" UX).
 */
export function discoverFiles(projectId: number, dataDir: string): FileRecord[] {
  // Reconcile first (index any new/changed files on disk), then return the
  // full set of indexed files for this project. Returning only newRecords
  // would give an empty result if registerProject already ran reconcileIndex.
  reconcileIndex({ projectId, dataDir });
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM files WHERE project_id = ? ORDER BY path")
    .all(projectId) as FileRecord[];
}

/**
 * Bulk-fetch tag names for many files in a single query.
 * Returns a Map keyed by file_id; missing keys = file has no tags.
 * Used by list_files / search / whats_new / project_map to inline tags
 * without an N+1 round-trip per file.
 */
export function getTagsForFiles(fileIds: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (fileIds.length === 0) return out;
  const db = getDatabase();
  const placeholders = fileIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ft.file_id AS file_id, t.name AS name
       FROM file_tags ft
       JOIN tags t ON t.id = ft.tag_id
       WHERE ft.file_id IN (${placeholders})
       ORDER BY t.name ASC`
    )
    .all(...fileIds) as { file_id: number; name: string }[];
  for (const r of rows) {
    const arr = out.get(r.file_id);
    if (arr) arr.push(r.name);
    else out.set(r.file_id, [r.name]);
  }
  return out;
}

/**
 * List all tags
 */
export function listTags(): TagRecord[] {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM tags ORDER BY name");
  return stmt.all() as TagRecord[];
}

export interface TagWithCount extends TagRecord { count: number }

/** Tags with file counts (LEFT JOIN so orphan tags get count=0). */
export function listTagsWithCounts(): TagWithCount[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT t.id, t.name, t.color, COUNT(ft.file_id) AS count " +
      "FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id " +
      "GROUP BY t.id ORDER BY count DESC, t.name ASC"
    )
    .all() as TagWithCount[];
}

export interface BacklinkRecord {
  id: number;
  title: string;
  path: string;
  snippet: string | null;
  reason: "title" | "basename" | "wikilink";
}

/** Strip FTS5-reserved punctuation so a phrase query built from a title doesn't syntax-error. */
function ftsPhraseSafe(s: string): string {
  return s.replace(/["'()*:^-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Files that mention the target file by title, basename, or [[wikilink]].
 * Uses FTS5 phrase search on the title and the extension-stripped basename.
 * Excludes the file itself and deduplicates across probes.
 */
export function findBacklinks(fileId: number, limit = 25): BacklinkRecord[] {
  const db = getDatabase();
  const target = db.prepare("SELECT id, title, path, project_id FROM files WHERE id = ?").get(fileId) as
    | { id: number; title: string; path: string; project_id: number | null }
    | undefined;
  if (!target) return [];

  const seen = new Set<number>([target.id]);
  const out: BacklinkRecord[] = [];

  const runProbe = (query: string, reason: BacklinkRecord["reason"]) => {
    const safe = ftsPhraseSafe(query);
    if (!safe) return;
    let hits: FileRecordWithRank[];
    try {
      // Scope to the target's project (or KB when project_id is null) — cross-project hits are noise, not backlinks.
      hits = search({ query: `"${safe}"`, limit, project_id: target.project_id });
    } catch {
      return;
    }
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push({ id: h.id, title: h.title, path: h.path, snippet: h.match_excerpt, reason });
      if (out.length >= limit) return;
    }
  };

  // Title phrase — the highest-signal probe.
  const trimmedTitle = target.title.trim();
  if (trimmedTitle.length >= 3) runProbe(trimmedTitle, "title");

  // Basename (extension stripped) catches path references like `slt-cdc-notes.md` in code blocks.
  if (out.length < limit) {
    const base = target.path.split(/[\\/]/).pop() ?? "";
    const stem = base.replace(/\.[^./]+$/, "");
    if (stem && stem.length >= 3 && stem.toLowerCase() !== trimmedTitle.toLowerCase()) {
      runProbe(stem, "basename");
    }
  }

  // Wikilink form — FTS strips brackets so this reuses the title probe. Return
  // as a distinct reason ONLY when a subsequent content check would confirm it;
  // for now we treat the title probe as covering it and don't over-claim.

  return out.slice(0, limit);
}

/**
 * List all projects
 */
export function listProjects(): ProjectRecord[] {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM projects ORDER BY name");
  return stmt.all() as ProjectRecord[];
}

/**
 * Reconcile the FTS index against disk.
 * If projectId is provided, scopes to that project's external path.
 * If projectId is null, refreshes the Knowledge Base under `<dataDir>/knowledge`.
 *
 * Serialized per-scope via withLock — concurrent refresh calls for the same
 * scope queue instead of racing on the FTS index. discoverFiles is NOT locked
 * (called only at register-time, before anyone else knows the project exists).
 */
export async function refreshIndex(projectId: number | null, dataDir: string) {
  const lockKey = typeof projectId === "number" ? `refresh:project:${projectId}` : "refresh:kb";
  return withLock(lockKey, async () => {
    const { newRecords: _newRecords, ...rest } = reconcileIndex({ projectId, dataDir });
    return rest;
  });
}
