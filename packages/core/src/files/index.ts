/**
 * File operations module for Kontexta
 * Handles CRUD operations for .md and .mmd files with SQLite indexing
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync, readdirSync, statSync, lstatSync, existsSync, rmSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { getDatabase } from "../db/index.js";
import { commitFile } from "../git/index.js";
import { assertPathInside, escapeLike, withLock, fileLockKey } from "../util/safety.js";
import { profileRelPath, repairProfile } from "../profile/index.js";
import type { FileRecord, Destination, FileFilters, StorageType } from "../types.js";

/**
 * List all folders in a project (recursively)
 */
export function listProjectFolders(projectPath: string): string[] {
  const folders: string[] = [];

  function scan(dir: string, currentRel: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;

      const fullPath = join(dir, entry);
      const relPath = currentRel ? join(currentRel, entry) : entry;

      try {
        // lstatSync (not statSync) so a symlink loop doesn't recurse forever.
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          folders.push(relPath);
          scan(fullPath, relPath);
        }
      } catch (e) {
        // Skip files that might have been deleted during scan
      }
    }
  }

  try {
    scan(projectPath, "");
  } catch (e) {
    console.error("Failed to scan project folders:", e);
  }

  return folders;
}

/**
 * List all folders in a project that contain at least one .md or .mmd file.
 * Returns only non-empty folders (useful for publish UI).
 */
export function listProjectFoldersWithFiles(projectPath: string): string[] {
  const folderFileCount = new Map<string, number>();

  function scan(dir: string, currentRel: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;

      const fullPath = join(dir, entry);
      const relPath = currentRel ? join(currentRel, entry) : entry;

      try {
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          scan(fullPath, relPath);
        } else if (lst.isFile()) {
          const ext = entry.endsWith(".mmd") ? ".mmd" : entry.endsWith(".md") ? ".md" : "";
          if (ext) {
            // Count file in every ancestor folder
            const parts = relPath.split("/");
            for (let i = 0; i < parts.length - 1; i++) {
              const ancestor = parts.slice(0, i + 1).join("/");
              folderFileCount.set(ancestor, (folderFileCount.get(ancestor) ?? 0) + 1);
            }
          }
        }
      } catch (e) {
        // Skip files that might have been deleted during scan
      }
    }
  }

  try {
    scan(projectPath, "");
  } catch (e) {
    console.error("Failed to scan project folders with files:", e);
  }

  // Return only folders with at least one .md/.mmd file
  const result: string[] = [];
  for (const [folder, count] of folderFileCount.entries()) {
    if (count > 0) result.push(folder);
  }
  return result.sort();
}

export interface CreateFileOptions {
  title: string;
  content: string;
  destination: Destination;
  projectId?: number;
  folder?: string;
  tags?: string[];
  dataDir: string;
  sourcePath?: string;
  /** File extension to write. Defaults to "md". */
  format?: "md" | "mmd";
}

export interface FileRecordWithContent extends FileRecord {
  content: string;
  git_warning?: string;
}

export interface ListFilesOptions {
  dataDir: string;
  filters?: FileFilters;
}

/**
 * Compute SHA-256 hash of content
 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
 * Create a new file
 */
export async function createFile(opts: CreateFileOptions): Promise<FileRecordWithContent> {
  const db = getDatabase();
  let { title, content, destination, projectId, folder, tags = [], dataDir, sourcePath, format = "md" } = opts;

  let filePath: string;
  let storageType: StorageType;
  let repairedContent: string;

  const slug = slugify(title);
  if (!slug) {
    throw new Error("Invalid title: produces empty slug");
  }
  const filename = `${slug}.${format}`;

  if (destination === "knowledge") {
    const knowledgeDir = join(dataDir, "knowledge");
    mkdirSync(knowledgeDir, { recursive: true });
    filePath = folder
      ? assertPathInside(knowledgeDir, join(folder, filename))
      : assertPathInside(knowledgeDir, filename);
    storageType = "local";
  } else if (destination === "kontexta") {
    if (!projectId) {
      throw new Error("projectId is required for kontexta destination");
    }
    const project = db.prepare("SELECT slug FROM projects WHERE id = ?").get(projectId) as { slug: string } | undefined;
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const projectDir = join(dataDir, "projects", project.slug);
    mkdirSync(projectDir, { recursive: true });
    filePath = folder
      ? assertPathInside(projectDir, join(folder, filename))
      : assertPathInside(projectDir, filename);
    storageType = "local";
  } else if (destination === "project") {
    if (!projectId) {
      throw new Error("projectId is required for project destination");
    }
    const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string | null } | undefined;
    if (!project || !project.path) {
      throw new Error(`Project path not found for project: ${projectId}`);
    }
    filePath = folder
      ? assertPathInside(project.path, join(folder, filename))
      : assertPathInside(project.path, filename);
    storageType = "reference";
  } else {
    throw new Error(`Unknown destination: ${destination}`);
  }

  // Serialise against any concurrent write to (or watcher event for) the
  // same file path. Without this, a chokidar `add` fired during the
  // disk-write window can interleave its own INSERT with this function's
  // UPSERT, and the FTS index can land with the watcher's interpretation
  // of the file (no tags, default title) instead of the caller's.
  return withLock(fileLockKey(filePath), async () => {
  mkdirSync(dirname(filePath), { recursive: true });
  // Stash pre-existing content (if any) so we can fully restore on a
  // DB-txn failure — otherwise writeFileSync below would leave the
  // caller's content sitting under a row that points elsewhere.
  let preExistingContent: Buffer | null = null;
  if (existsSync(filePath)) {
    try {
      preExistingContent = readFileSync(filePath);
    } catch (e) {
      console.warn("createFile: failed to stash pre-existing content for rollback:", e);
    }
  }
  // Auto-repair profile.md — insert missing required sections.
  const isProfile = destination === "knowledge" && filePath === join(dataDir, profileRelPath());
  let repairedSections: string[] | undefined;
  if (isProfile) {
    let { content: repairedContent, repaired } = repairProfile(content);
    repairedSections = repaired;
    content = repairedContent;
  }
  writeFileSync(filePath, content, "utf8");
  const contentHash = computeHash(content);

  // ON CONFLICT(path) absorbs the watcher's stub row if chokidar's `add` won the race.
  const upsertStmt = db.prepare(`
    INSERT INTO files (path, title, project_id, storage_type, source_path, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      project_id = excluded.project_id,
      storage_type = excluded.storage_type,
      source_path = excluded.source_path,
      content_hash = excluded.content_hash,
      updated_at = datetime('now')
  `);
  const getIdByPathStmt = db.prepare("SELECT id FROM files WHERE path = ?");
  const insertTagStmt = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const getTagStmt = db.prepare("SELECT id FROM tags WHERE name = ?");
  const linkTagStmt = db.prepare("INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)");
  const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
  const ftsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");

  // Snapshot for rollback — upsert may overwrite an existing row.
  const priorRow = db
    .prepare("SELECT id, title, project_id, storage_type, source_path, content_hash, updated_at FROM files WHERE path = ?")
    .get(filePath) as
    | { id: number; title: string; project_id: number | null; storage_type: string; source_path: string | null; content_hash: string; updated_at: string }
    | undefined;

  let fileId: number;
  try {
    fileId = db.transaction(() => {
      upsertStmt.run(filePath, title, projectId || null, storageType, sourcePath || null, contentHash);
      const row = getIdByPathStmt.get(filePath) as { id: number } | undefined;
      if (!row) throw new Error(`createFile: row missing after upsert for ${filePath}`);
      const id = row.id;

      if (tags.length > 0) {
        for (const tagName of tags) {
          insertTagStmt.run(tagName);
          const tag = getTagStmt.get(tagName) as { id: number } | undefined;
          if (!tag) continue;
          linkTagStmt.run(id, tag.id);
        }
      }

      // Replace FTS in case the watcher inserted first.
      deleteFtsStmt.run(id);
      ftsStmt.run(id, title, content);
      return id;
    })();
  } catch (dbError) {
    if (preExistingContent !== null) {
      try { writeFileSync(filePath, preExistingContent as any); } catch (e) {
        console.error("createFile: failed to restore pre-existing content after DB error:", e);
      }
    } else {
      try { unlinkSync(filePath); } catch {}
    }
    // Roll DB back to priorRow (if any) or delete the freshly-inserted row.
    try {
      if (priorRow) {
        db.prepare(
          "UPDATE files SET title=?, project_id=?, storage_type=?, source_path=?, content_hash=?, updated_at=? WHERE id=?"
        ).run(priorRow.title, priorRow.project_id, priorRow.storage_type, priorRow.source_path, priorRow.content_hash, priorRow.updated_at, priorRow.id);
      } else {
        db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
      }
    } catch (e) {
      console.error("createFile: failed to roll back DB row after error:", e);
    }
    throw dbError;
  }

  const fileRecord = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as FileRecord;

  // Reference files version against their project's own git, not the data dir.
  let gitWarning: string | undefined;
  try {
    let repoDir = dataDir;
    if (storageType === "reference" && projectId) {
      const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string | null } | undefined;
      if (project?.path) repoDir = project.path;
    }
    await commitFile(repoDir, filePath, `Create context file: ${title}`);
  } catch (error) {
    gitWarning = error instanceof Error ? error.message : String(error);
    console.warn("Git auto-commit failed during creation:", error);
  }

  return {
    ...fileRecord,
    content,
    ...(gitWarning ? { git_warning: gitWarning } : {}),
  };
  });
}

/**
 * Read a file by ID
 */
export function readFile(id: number): FileRecordWithContent {
  const db = getDatabase();

  const fileRecord = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRecord | undefined;
  if (!fileRecord) {
    throw new Error(`File not found: ${id}`);
  }

  const content = readFileSync(fileRecord.path, "utf8");

  return {
    ...fileRecord,
    content,
  };
}

/**
 * Update file content
 */
export async function updateFile(id: number, content: string, dataDir: string): Promise<FileRecordWithContent> {
  const db = getDatabase();

  const fileRecord = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRecord | undefined;
  if (!fileRecord) {
    throw new Error(`File not found: ${id}`);
  }

  // Same path-keyed lock as createFile — serialises against the watcher
  // so a chokidar `change` fired mid-write can't run its own UPDATE +
  // FTS rebuild interleaved with ours.
  return withLock(fileLockKey(fileRecord.path), async () => {
  // Stash pre-existing content so we can restore the disk file if the DB
  // transaction below fails — otherwise the new bytes would sit on disk
  // under a row whose content_hash and FTS index still reflect the old
  // content, leaving permanent drift.
  let preExistingContent: Buffer | null = null;
  if (existsSync(fileRecord.path)) {
    try {
      preExistingContent = readFileSync(fileRecord.path);
    } catch (e) {
      console.warn("updateFile: failed to stash pre-existing content for rollback:", e);
    }
  }
  writeFileSync(fileRecord.path, content, "utf8");
  const contentHash = computeHash(content);

  // Atomic so a partial failure can't leave the FTS index pointing at stale content.
  const updateStmt = db.prepare(`
    UPDATE files
    SET content_hash = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
  const insertFtsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");

  try {
    db.transaction(() => {
      updateStmt.run(contentHash, id);
      deleteFtsStmt.run(id);
      insertFtsStmt.run(id, fileRecord.title, content);
    })();
  } catch (dbError) {
    if (preExistingContent !== null) {
      try { writeFileSync(fileRecord.path, preExistingContent as any); } catch (e) {
        console.error("updateFile: failed to restore pre-existing content after DB error:", e);
      }
    }
    throw dbError;
  }

  let gitWarning: string | undefined;
  try {
    let repoDir = dataDir;
    if (fileRecord.storage_type === "reference" && fileRecord.project_id) {
      const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(fileRecord.project_id) as { path: string | null } | undefined;
      if (project?.path) repoDir = project.path;
    }
    await commitFile(repoDir, fileRecord.path, `Update context file: ${fileRecord.title}`);
  } catch (error) {
    gitWarning = error instanceof Error ? error.message : String(error);
    console.warn("Git auto-commit failed during update:", error);
  }

  const updatedRecord = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRecord;
  return {
    ...updatedRecord,
    content,
    ...(gitWarning ? { git_warning: gitWarning } : {}),
  };
  });
}

/**
 * Delete a file. Always removes the DB row; only unlinks from disk when
 * the file is inside `<dataDir>/knowledge/` (project files are never
 * physically deleted — we only un-index).
 */
export function deleteFile(id: number, dataDir?: string): void {
  const db = getDatabase();

  const file = db.prepare("SELECT path, project_id FROM files WHERE id = ?").get(id) as
    | { path: string; project_id: number | null }
    | undefined;

  if (!file) {
    throw new Error(`File not found: ${id}`);
  }

  if (file && dataDir) {
    const knowledgeRoot = resolve(dataDir, "knowledge");
    // Resolve file path relative to dataDir if it's not absolute
    const filePathResolved = isAbsolute(file.path) ? file.path : resolve(dataDir, file.path);
    const inKnowledge =
      filePathResolved === knowledgeRoot ||
      filePathResolved.startsWith(knowledgeRoot + sep);

    if (file.project_id === null && inKnowledge) {
      try {
        if (existsSync(filePathResolved)) {
          unlinkSync(filePathResolved);
        }
      } catch (e) {
        console.error("Failed to delete Knowledge Base file from disk:", e);
      }
    }
  }

  // CASCADE handles file_tags + favorites via the files row deletion.
  const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
  const deleteStmt = db.prepare("DELETE FROM files WHERE id = ?");
  db.transaction(() => {
    deleteFtsStmt.run(id);
    deleteStmt.run(id);
  })();
}

/**
 * Create a new folder in a project
 */
export function createFolder(projectPath: string, folderName: string): string {
  const fullPath = assertPathInside(projectPath, folderName);
  mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

/**
 * Delete a folder (recursive)
 */
export function deleteFolder(projectPath: string, folderName: string): void {
  const fullPath = assertPathInside(projectPath, folderName);
  rmSync(fullPath, { recursive: true, force: true });
}

/**
 * List files with optional filters
 */
export function listFiles(opts: ListFilesOptions): FileRecord[] {
  const db = getDatabase();
  const { filters } = opts;

  let sql = "SELECT * FROM files WHERE 1=1";
  const params: any[] = [];

  if (filters) {
    if (filters.project_id !== undefined) {
      if (filters.project_id === null) {
        sql += " AND project_id IS NULL";
      } else {
        sql += " AND project_id = ?";
        params.push(filters.project_id);
      }
    }

    if (filters.storage_type !== undefined) {
      sql += " AND storage_type = ?";
      params.push(filters.storage_type);
    }

    if (filters.favorite !== undefined && filters.favorite) {
      sql += " AND EXISTS (SELECT 1 FROM favorites WHERE favorites.file_id = files.id)";
    }

    if (filters.tag !== undefined) {
      sql += ` AND EXISTS (
        SELECT 1 FROM file_tags
        JOIN tags ON tags.id = file_tags.tag_id
        WHERE file_tags.file_id = files.id AND tags.name = ?
      )`;
      params.push(filters.tag);
    }

    if (filters.untagged === true) {
      sql += " AND NOT EXISTS (SELECT 1 FROM file_tags WHERE file_tags.file_id = files.id)";
    }

    if (filters.folder !== undefined) {
      const segment = escapeLike(filters.folder);
      if (filters.project_path) {
        // Scope to files under the given project root.
        sql += " AND (path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')";
        params.push(`${filters.project_path}/${segment}/%`);
        params.push(`${filters.project_path}\\${segment}\\%`);
      } else {
        // Original behaviour: match any path segment named like folder.
        sql += " AND (path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')";
        params.push(`%/${segment}/%`);
        params.push(`%\\${segment}\\%`);
      }
    }
  }

  sql += " ORDER BY updated_at DESC";

  if (filters?.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(filters.limit);
  }

  if (filters?.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(filters.offset);
  }

  const stmt = db.prepare(sql);
  return stmt.all(...params) as FileRecord[];
}

/**
 * Move a file to a new path
 */
export function moveFile(id: number, newPath: string): FileRecord {
  const db = getDatabase();

  const fileRecord = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRecord | undefined;
  if (!fileRecord) {
    throw new Error(`File not found: ${id}`);
  }

  const oldPath = fileRecord.path;
  if (newPath !== oldPath && existsSync(newPath)) {
    throw new Error(`moveFile: destination already exists: ${newPath}`);
  }
  mkdirSync(dirname(newPath), { recursive: true });
  renameSync(oldPath, newPath);

  // If the DB UPDATE fails (UNIQUE conflict, etc.) we'd be left with the
  // file at newPath but the row pointing at oldPath — in the web app the
  // watcher would then unlink the row (losing tags/favorites). Roll the
  // disk rename back so the system stays consistent.
  const updateStmt = db.prepare("UPDATE files SET path = ?, updated_at = datetime('now') WHERE id = ?");
  try {
    updateStmt.run(newPath, id);
  } catch (e) {
    try { renameSync(newPath, oldPath); } catch (rollbackErr) {
      throw new Error(
        `moveFile failed and rollback also failed; disk and DB are out of sync. ` +
        `update error: ${(e as any)?.message ?? e}; rollback error: ${(rollbackErr as any)?.message ?? rollbackErr}`
      );
    }
    throw e;
  }

  const updatedRecord = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRecord;
  return updatedRecord;
}
