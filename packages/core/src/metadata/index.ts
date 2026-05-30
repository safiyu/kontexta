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
 * Add tags to a file
 */
export function addTags(fileId: number, tagNames: string[]): void {
  const db = getDatabase();

  const insertTagStmt = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const getTagStmt = db.prepare("SELECT id FROM tags WHERE name = ?");
  const linkTagStmt = db.prepare("INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)");

  db.transaction(() => {
    for (const tagName of tagNames) {
      insertTagStmt.run(tagName);
      const tag = getTagStmt.get(tagName) as { id: number } | undefined;
      if (!tag) continue;
      linkTagStmt.run(fileId, tag.id);
    }
  })();
}

/**
 * Remove tags from a file
 */
export function removeTags(fileId: number, tagIds: number[]): void {
  const db = getDatabase();

  const deleteStmt = db.prepare("DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?");

  for (const tagId of tagIds) {
    deleteStmt.run(fileId, tagId);
  }
}

/**
 * Set or unset a file as favorite
 */
export function setFavorite(fileId: number, favorite: boolean): void {
  const db = getDatabase();

  if (favorite) {
    const insertStmt = db.prepare("INSERT OR IGNORE INTO favorites (file_id) VALUES (?)");
    insertStmt.run(fileId);
  } else {
    const deleteStmt = db.prepare("DELETE FROM favorites WHERE file_id = ?");
    deleteStmt.run(fileId);
  }
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
    sql += " AND files.project_id = ?";
    params.push(filters.project_id);
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

  sql += " ORDER BY rank LIMIT 50";

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
): ProjectRecord {
  const db = getDatabase();

  const slug = slugify(name);
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO projects (name, slug, path, description, remote_url)
    VALUES (?, ?, ?, ?, ?)
  `);

  const absolutePath = resolve(path);
  const result = insertStmt.run(name, slug, absolutePath, description || null, remoteUrl || null);

  if (result.changes > 0) {
    const projectId = Number(result.lastInsertRowid);
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRecord;
  }

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
  if (existing.path !== absolutePath) {
    const conflicts: string[] = [];
    if (byName) conflicts.push(`name conflicts with '${byName.name}' at '${byName.path}'`);
    if (bySlug && bySlug.id !== byName?.id) conflicts.push(`slug '${slug}' conflicts with '${bySlug.name}' at '${bySlug.path}'`);
    const err = new Error(
      `Cannot register '${name}' at '${path}': ${conflicts.join("; ")}. ` +
      `Pick a different name or unregister the existing project first.`
    );
    (err as any).code = "PROJECT_CONFLICT";
    throw err;
  }
  return existing;
}

/**
 * Unregister a project and remove all its file metadata
 */
export function unregisterProject(projectId: number, dataDir?: string): void {
  const db = getDatabase();

  // Capture slug before deleting the row — needed for backup subtree cleanup below.
  const project = db.prepare("SELECT slug FROM projects WHERE id = ?").get(projectId) as
    | { slug: string }
    | undefined;

  db.transaction(() => {
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
  })();

  // Outside the txn: remove the backup subtree so re-register doesn't resurrect ghosts.
  // next syncBackup doesn't resurrect ghost files. Best-effort; log on fail.
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
          // Surface for project scope — clear config error.
          throw new Error(`Failed to read project root ${dir}: ${(e as any)?.message ?? e}`);
        }
        // KB scope: log and bail. The caller (and the topLevelWalkOk guard
        // below) ensures we don't prune away the entire knowledge base on a
        // transient EACCES.
        console.warn(`reconcileIndex: failed to read KB root ${dir}: ${(e as any)?.message ?? e}`);
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
  return reconcileIndex({ projectId, dataDir }).newRecords;
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
