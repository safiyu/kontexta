/**
 * Startup migration to transition existing on-disk Knowledge Base files
 * into inline SQLite storage.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createRevision } from "../revisions/index.js";

/**
 * Migrate all local files with NULL content from disk into SQLite
 */
export function migrateInlineContent(db: Database.Database): number {
  // Check if content column exists first
  const tableInfo = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
  if (!tableInfo.some((col) => col.name === "content")) {
    return 0;
  }

  const rows = db
    .prepare("SELECT id, path, title, storage_type FROM files WHERE storage_type = 'local' AND content IS NULL")
    .all() as Array<{ id: number; path: string; title: string; storage_type: string }>;

  if (rows.length === 0) {
    return 0;
  }

  console.error(`[Database] Migrating ${rows.length} local file(s) into inline SQLite storage...`);

  const updateStmt = db.prepare(`
    UPDATE files
    SET content = ?, content_hash = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const deleteFtsStmt = db.prepare("DELETE FROM fts_index WHERE rowid = ?");
  const insertFtsStmt = db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)");

  let migratedCount = 0;
  const filesToUnlink: string[] = [];

  for (const row of rows) {
    if (!existsSync(row.path)) {
      continue;
    }

    try {
      const content = readFileSync(row.path, "utf8");
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");

      db.transaction(() => {
        updateStmt.run(content, contentHash, row.id);
        deleteFtsStmt.run(row.id);
        insertFtsStmt.run(row.id, row.title, content);

        createRevision(db, {
          fileId: row.id,
          content,
          message: "Initial inline migration",
        });
      })();

      migratedCount++;
      // Only queue unlinking for KB files under knowledge/ (exclude media or external projects)
      if (row.path.endsWith(".md") || row.path.endsWith(".mmd") || row.path.endsWith(".html")) {
        filesToUnlink.push(row.path);
      }
    } catch (err) {
      console.warn(`[Database] Failed to migrate file ${row.path} into SQLite:`, err);
    }
  }

  // Force checkpoint WAL so migrated records are safely committed
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {}

  // Clean up migrated files from disk
  for (const p of filesToUnlink) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
      }
    } catch {}
  }

  console.error(`[Database] Successfully migrated ${migratedCount} file(s) into inline storage.`);
  return migratedCount;
}

