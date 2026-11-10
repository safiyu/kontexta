/**
 * Native Revision Engine for Kontexta
 * Manages compressed historical snapshots and diffs inside SQLite.
 */
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import type Database from "better-sqlite3";

export interface FileRevision {
  id: number;
  file_id: number;
  rev_hash: string;
  message: string;
  author: string;
  created_at: string;
}

export interface FileRevisionWithContent extends FileRevision {
  content: string;
}

/**
 * Generate a deterministic 40-character hex revision hash
 */
export function generateRevisionHash(
  fileId: number,
  content: string,
  createdAtMs: number = Date.now()
): string {
  const hash = createHash("sha256");
  hash.update(`${fileId}:${createdAtMs}:${content}`, "utf8");
  return hash.digest("hex").slice(0, 40);
}

/**
 * Compress text using Brotli
 */
export function compressContent(content: string): Buffer {
  return brotliCompressSync(Buffer.from(content, "utf8"));
}

/**
 * Decompress Brotli buffer to UTF-8 string
 */
export function decompressContent(compressed: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(compressed) ? compressed : Buffer.from(compressed);
  return brotliDecompressSync(buf).toString("utf8");
}

/**
 * Insert a new revision for a file into SQLite
 */
export function createRevision(
  db: Database.Database,
  opts: {
    fileId: number;
    content: string;
    message: string;
    author?: string;
    revHash?: string;
  }
): FileRevision {
  const { fileId, content, message, author = "Kontexta" } = opts;
  const compressed = compressContent(content);
  const revHash = opts.revHash ?? generateRevisionHash(fileId, content);

  const stmt = db.prepare(`
    INSERT INTO file_revisions (file_id, rev_hash, content_compressed, message, author, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const info = stmt.run(fileId, revHash, compressed, message, author);
  const id = Number(info.lastInsertRowid);

  const row = db
    .prepare("SELECT id, file_id, rev_hash, message, author, created_at FROM file_revisions WHERE id = ?")
    .get(id) as FileRevision;

  return row;
}

/**
 * List all revisions for a file in reverse chronological order
 */
export function listRevisions(
  db: Database.Database,
  fileId: number
): Array<{ hash: string; message: string; date: string; author: string }> {
  const rows = db
    .prepare(
      "SELECT rev_hash AS hash, message, created_at AS date, author FROM file_revisions WHERE file_id = ? ORDER BY id DESC"
    )
    .all(fileId) as Array<{ hash: string; message: string; date: string; author: string }>;

  return rows;
}

/**
 * Get the decompressed content of a revision by fileId and revHash
 */
export function getRevisionContent(
  db: Database.Database,
  fileId: number,
  revHash: string
): string | null {
  const row = db
    .prepare("SELECT content_compressed FROM file_revisions WHERE file_id = ? AND rev_hash = ?")
    .get(fileId, revHash) as { content_compressed: Buffer } | undefined;

  if (!row) return null;
  return decompressContent(row.content_compressed);
}

/**
 * Compute a basic unified diff between two text strings in memory
 */
export function computeUnifiedDiff(
  oldStr: string,
  newStr: string,
  filePath: string = "file"
): string {
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);

  // If identical
  if (oldStr === newStr) {
    return "";
  }

  // Simple Myers/LCS diff implementation for clean unified diff output
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const diffChunks: string[] = [];
  diffChunks.push(`--- a/${filePath}`);
  diffChunks.push(`+++ b/${filePath}`);
  diffChunks.push(`@@ -1,${m} +1,${n} @@`);

  let i = m;
  let j = n;
  const stack: string[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push(` ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push(`+${newLines[j - 1]}`);
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      stack.push(`-${oldLines[i - 1]}`);
      i--;
    }
  }

  while (stack.length > 0) {
    diffChunks.push(stack.pop()!);
  }

  return diffChunks.join("\n") + "\n";
}

