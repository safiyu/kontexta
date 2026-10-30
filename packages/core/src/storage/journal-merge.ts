/**
 * Union merge for daily journal files.
 *
 * `knowledge/journal/journal-YYYY-MM-DD.md` is append-only: a header followed by `---` separated blocks that each start
 * with a `**YYYY-MM-DD HH:MM:SS**` timestamp. Two machines writing the same day never conflict in meaning, so their
 * versions merge to the sorted union of blocks. The merge is deterministic, commutative and idempotent, so every machine
 * reaches identical content regardless of the order it sees the versions in.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { enqueueOp } from "./outbox.js";
import { toRelPath, resolveSyncPath } from "./paths.js";
import { forkConflictFromOp } from "./conflicts.js";
import type { Op } from "./op.js";

const DAILY_JOURNAL_REL = /^knowledge\/journal\/journal-\d{4}-\d{2}-\d{2}\.md$/;
const SEPARATOR = "\n---\n";
const STAMP = /^\*\*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\*\*/;

export function isDailyJournalPath(absPath: string): boolean {
  const rel = toRelPath(absPath);
  return rel !== null && DAILY_JOURNAL_REL.test(rel);
}

function parse(content: string): { header: string; blocks: string[] } {
  const idx = content.indexOf(SEPARATOR);
  if (idx === -1) return { header: content.replace(/\s+$/, ""), blocks: [] };
  const blocks = content
    .slice(idx + SEPARATOR.length)
    .split(SEPARATOR)
    .map((b) => b.replace(/\s+$/, ""))
    .filter((b) => b !== "");
  return { header: content.slice(0, idx).replace(/\s+$/, ""), blocks };
}

/** Sorted union of the blocks of both versions; the lexicographically smaller header wins so the result never depends on argument order. */
export function mergeJournalContent(a: string, b: string): string {
  const pa = parse(a);
  const pb = parse(b);
  const blocks = [...new Set([...pa.blocks, ...pb.blocks])].sort((x, y) => {
    const sx = STAMP.exec(x)?.[1] ?? "";
    const sy = STAMP.exec(y)?.[1] ?? "";
    return sx < sy ? -1 : sx > sy ? 1 : x < y ? -1 : x > y ? 1 : 0;
  });
  const header = pa.header <= pb.header ? pa.header : pb.header;
  return blocks.length === 0 ? `${header}\n` : `${header}\n\n---\n${blocks.join("\n\n---\n")}\n`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function machineId(db: Database): string {
  return (db.prepare("SELECT value FROM settings WHERE key = 'machine_id'").get() as { value: string }).value;
}

/**
 * Merge `remoteContent` into the local journal file `localGid` at `path`. The local file and row take the union, and an
 * update carrying it is pushed unless the remote already holds exactly that content.
 */
export function mergeJournalInto(db: Database, localGid: string, path: string, remoteContent: string): void {
  const local = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const merged = mergeJournalContent(local, remoteContent);
  const row = db.prepare("SELECT id, title FROM files WHERE gid = ?").get(localGid) as { id: number; title: string } | undefined;
  if (merged !== local) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, merged, "utf8");
    if (row) {
      db.prepare("UPDATE files SET content_hash = ?, updated_at = datetime('now') WHERE id = ?").run(sha256(merged), row.id);
      db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(row.id);
      db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(row.id, row.title, merged);
    }
  }
  if (merged !== remoteContent) {
    enqueueOp(db, {
      gid: localGid,
      kind: "file.update",
      origin: machineId(db),
      base_version: 0,
      payload: {
        path,
        rel_path: toRelPath(path) ?? undefined,
        title: row?.title ?? basename(path),
        content: merged,
        content_hash: sha256(merged),
      },
      created_at: Date.now(),
    });
  }
}

/** A remote content op that cannot simply apply: daily journals merge, everything else becomes a conflict copy. */
export function mergeOrFork(db: Database, op: Op, serverSeq?: number): "merged" | "forked" {
  const payload = op.payload as { path?: string; rel_path?: string; content?: unknown };
  const path = resolveSyncPath(payload.path, payload.rel_path);
  if (isDailyJournalPath(path)) {
    mergeJournalInto(db, op.gid, path, typeof payload.content === "string" ? payload.content : "");
    return "merged";
  }
  forkConflictFromOp(op, db, { serverSeq });
  return "forked";
}
