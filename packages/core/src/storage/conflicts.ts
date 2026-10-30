/**
 * Conflict resolution core engine — Phase 5 (storage/05-conflicts).
 *
 * Spec 1.7 (Conflict Resolution Model):
 *   1. Server Authority: The kontexta-storage-server assigns sequential ordering (seq).
 *      Client clocks are considered untrusted.
 *   2. Detection & Preservation: If an incoming op on the server has a base_version
 *      lower than the current canonical version for that gid, the server flags a conflict.
 *   3. Client Forking: When a client receives a conflicted operation for a file, it does
 *      not overwrite the canonical file. Instead, it writes a timestamped conflict copy
 *      alongside the canonical file:
 *        `<filename> (from <machine_label>).<ext>`
 *      and inserts a record into the local conflict registry (`conflicts` table).
 *   4. Conflict Manager: Surfaces diffs and provides 4 deterministic resolution strategies
 *      via UI (/conflicts) and MCP tools (conflicts_list, conflicts_get, conflicts_resolve):
 *        - `keep-server`: Accept remote state and delete conflict copy.
 *        - `keep-mine`: Re-assert local state, increment version, push to server, delete conflict copy.
 *        - `keep-both`: Retain canonical file and permanently keep the copy renamed as `<filename> (from <machine_label>).<ext>`.
 *        - `merged`: Apply user-provided custom merged text, delete conflict copy, and push merged update.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/index.js";
import { formatGid } from "../identity/gid.js";
import { getMachineId, getMachineLabel } from "../identity/machine.js";
import { withLock, fileLockKey } from "../util/safety.js";
import { enqueueOp } from "./outbox.js";
import { toRelPath, resolveSyncPath } from "./paths.js";
import type { Op } from "./op.js";

// ---------------------------------------------------------------------------
// Types & Interfaces (spec 1.7)
// ---------------------------------------------------------------------------

export type ConflictStatus = "unresolved" | "resolved";

export type ConflictStrategy = "keep-server" | "keep-mine" | "keep-both" | "merged";

export interface DiffResult {
  diff: string;
  additions: number;
  deletions: number;
}

export interface ConflictRecord {
  id: number;
  gid: string;
  file_path: string;
  conflict_path: string;
  origin: string;
  origin_label: string | null;
  base_version: number | null;
  server_seq: number | null;
  local_content: string;
  remote_content: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  status: ConflictStatus;
  resolution: ConflictStrategy | null;
  resolved_at: number | null;
  created_at: number;
}

export interface RegisterConflictInput {
  gid: string;
  filePath: string;
  conflictPath?: string;
  origin: string;
  originLabel?: string | null;
  baseVersion?: number | null;
  serverSeq?: number | null;
  remoteContent: string;
  localContent?: string;
  createdAt?: number;
}

export interface ListConflictsOptions {
  status?: ConflictStatus | "all";
  limit?: number;
}

export interface ResolveConflictOptions {
  strategy: ConflictStrategy;
  mergedContent?: string;
}

export interface ResolveConflictResult {
  success: boolean;
  gid: string;
  strategy: ConflictStrategy;
  resolvedAt: number;
  outboxOpId?: number;
  newFileGid?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function resolveDb(db?: Database.Database): Database.Database {
  return db ?? getDatabase();
}

function readLocalMachineId(db: Database.Database): string {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'machine_id'")
      .get() as { value: string } | undefined;
    if (row?.value) return row.value;
  } catch {}
  try {
    return getMachineId();
  } catch {
    return "0000000000000000";
  }
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/**
 * Ensure the `conflicts` table and indexes exist in the target database.
 * Completely idempotent.
 */
export function ensureConflictsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conflicts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      gid            TEXT    NOT NULL,
      file_path      TEXT    NOT NULL,
      conflict_path  TEXT    NOT NULL,
      origin         TEXT    NOT NULL,
      origin_label   TEXT,
      base_version   INTEGER,
      server_seq     INTEGER,
      local_content  TEXT    NOT NULL DEFAULT '',
      remote_content TEXT    NOT NULL DEFAULT '',
      status         TEXT    NOT NULL DEFAULT 'unresolved'
                     CHECK (status IN ('unresolved', 'resolved')),
      resolution     TEXT    CHECK (resolution IN ('keep-server', 'keep-mine', 'keep-both', 'merged')),
      resolved_at    INTEGER,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conflicts_gid ON conflicts(gid);
    CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
  `);
}

// ---------------------------------------------------------------------------
// Conflict Path Builder (spec 1.7)
// ---------------------------------------------------------------------------

/**
 * Builds the conflict copy filename alongside the canonical file:
 *   `<filename> (from <machine_label>).<ext>`
 *
 * If the default conflict path already exists on disk and is distinct, an optional
 * timestamp is appended to avoid collisions:
 *   `<filename> (from <machine_label> <timestamp>).<ext>`
 */
export function buildConflictPath(
  canonicalPath: string,
  originLabelOrMachineId?: string | null,
  options?: { timestamp?: number | boolean }
): string {
  const dir = dirname(canonicalPath);
  const ext = extname(canonicalPath);
  const base = basename(canonicalPath, ext);

  const cleanLabel = (originLabelOrMachineId ?? "remote")
    .replace(/[/\\:*?"<>|]/g, "-")
    .trim() || "remote";

  if (options?.timestamp) {
    const ts = typeof options.timestamp === "number" ? options.timestamp : Date.now();
    return join(dir, `${base} (from ${cleanLabel} ${ts})${ext}`);
  }

  const standardPath = join(dir, `${base} (from ${cleanLabel})${ext}`);
  return standardPath;
}

// ---------------------------------------------------------------------------
// Pure Diff Computation (Myers Line Diff)
// ---------------------------------------------------------------------------

interface DiffOp {
  type: "equal" | "delete" | "insert";
  line: string;
}

/** Edit-distance ceiling for the exact diff; past it the middle block is reported as replaced wholesale. */
const MAX_EDIT_DISTANCE = 2000;

function myersEdits(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, MAX_EDIT_DISTANCE);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  let found = false;
  loop: for (let d = 0; d <= limit; d++) {
    // Only diagonals [-d, d] are read at step d, so that slice is all the backtrack needs.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break loop;
      }
    }
  }
  if (!found) return null;

  const result: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vPrev = trace[d];
    const at = (k: number): number => vPrev[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;

    while (x > prevX && y > prevY) {
      result.push({ type: "equal", line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        result.push({ type: "insert", line: b[y - 1] });
        y--;
      } else {
        result.push({ type: "delete", line: a[x - 1] });
        x--;
      }
    }
  }
  return result.reverse();
}

function myersDiff(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid =
    myersEdits(midA, midB) ??
    [
      ...midA.map((line): DiffOp => ({ type: "delete", line })),
      ...midB.map((line): DiffOp => ({ type: "insert", line })),
    ];
  return [
    ...a.slice(0, start).map((line): DiffOp => ({ type: "equal", line })),
    ...mid,
    ...a.slice(endA).map((line): DiffOp => ({ type: "equal", line })),
  ];
}

/**
 * Generate a unified diff and addition/deletion counts between local and remote content.
 */
export function computeDiff(
  localContent: string,
  remoteContent: string,
  labels?: { local?: string; remote?: string }
): DiffResult {
  if (localContent === remoteContent) {
    return { diff: "", additions: 0, deletions: 0 };
  }

  const a = localContent === "" ? [] : localContent.split(/\r?\n/);
  const b = remoteContent === "" ? [] : remoteContent.split(/\r?\n/);

  const ops = myersDiff(a, b);
  let additions = 0;
  let deletions = 0;

  for (const op of ops) {
    if (op.type === "insert") additions++;
    else if (op.type === "delete") deletions++;
  }

  const localLabel = labels?.local ?? "local";
  const remoteLabel = labels?.remote ?? "remote";

  const lines: string[] = [
    `--- ${localLabel}`,
    `+++ ${remoteLabel}`,
    `@@ -1,${a.length} +1,${b.length} @@`,
  ];

  for (const op of ops) {
    if (op.type === "equal") {
      lines.push(` ${op.line}`);
    } else if (op.type === "delete") {
      lines.push(`-${op.line}`);
    } else if (op.type === "insert") {
      lines.push(`+${op.line}`);
    }
  }

  return {
    diff: lines.join("\n"),
    additions,
    deletions,
  };
}

// ---------------------------------------------------------------------------
// Conflict Registration & Forking (spec 1.7)
// ---------------------------------------------------------------------------

/**
 * Register a conflicted operation:
 *   1. Writes the remote content to the conflict copy path on disk.
 *   2. Inserts or updates the unresolved conflict record in the `conflicts` table.
 */
export function registerConflict(
  input: RegisterConflictInput,
  dbHandle?: Database.Database
): ConflictRecord {
  const db = resolveDb(dbHandle);
  ensureConflictsTable(db);

  const now = input.createdAt ?? Date.now();

  // 1. Resolve local content
  let localContent = input.localContent;
  if (localContent === undefined) {
    if (existsSync(input.filePath)) {
      try {
        localContent = readFileSync(input.filePath, "utf-8");
      } catch {
        localContent = "";
      }
    } else {
      try {
        const fileRow = db
          .prepare("SELECT id FROM files WHERE gid = ? OR path = ?")
          .get(input.gid, input.filePath) as { id: number } | undefined;
        if (fileRow) {
          const ftsRow = db
            .prepare("SELECT content FROM fts_index WHERE rowid = ?")
            .get(fileRow.id) as { content: string } | undefined;
          localContent = ftsRow?.content ?? "";
        } else {
          localContent = "";
        }
      } catch {
        localContent = "";
      }
    }
  }

  // 2. Resolve conflict path
  let conflictPath = input.conflictPath;
  if (!conflictPath) {
    const candidatePath = buildConflictPath(input.filePath, input.originLabel ?? input.origin);
    // If a different conflict file already exists at candidatePath, add a timestamp
    if (existsSync(candidatePath)) {
      try {
        const existingBytes = readFileSync(candidatePath, "utf-8");
        if (existingBytes !== input.remoteContent) {
          conflictPath = buildConflictPath(input.filePath, input.originLabel ?? input.origin, {
            timestamp: now,
          });
        } else {
          conflictPath = candidatePath;
        }
      } catch {
        conflictPath = candidatePath;
      }
    } else {
      conflictPath = candidatePath;
    }
  }

  // 3. Write remote content to the conflict copy on disk
  mkdirSync(dirname(conflictPath), { recursive: true });
  writeFileSync(conflictPath, input.remoteContent, "utf8");

  // 4. Update existing unresolved conflict for gid or insert new row
  let conflictId: number;
  const existing = db
    .prepare("SELECT id FROM conflicts WHERE gid = ? AND status = 'unresolved'")
    .get(input.gid) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE conflicts SET
        file_path = ?,
        conflict_path = ?,
        origin = ?,
        origin_label = ?,
        base_version = ?,
        server_seq = ?,
        local_content = ?,
        remote_content = ?,
        created_at = ?
      WHERE id = ?
    `).run(
      input.filePath,
      conflictPath,
      input.origin,
      input.originLabel ?? null,
      input.baseVersion ?? null,
      input.serverSeq ?? null,
      localContent,
      input.remoteContent,
      now,
      existing.id
    );
    conflictId = existing.id;
  } else {
    const res = db.prepare(`
      INSERT INTO conflicts (
        gid, file_path, conflict_path, origin, origin_label,
        base_version, server_seq, local_content, remote_content,
        status, resolution, resolved_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', NULL, NULL, ?)
    `).run(
      input.gid,
      input.filePath,
      conflictPath,
      input.origin,
      input.originLabel ?? null,
      input.baseVersion ?? null,
      input.serverSeq ?? null,
      localContent,
      input.remoteContent,
      now
    );
    conflictId = Number(res.lastInsertRowid);
  }

  const { diff, additions, deletions } = computeDiff(localContent, input.remoteContent);

  return {
    id: conflictId,
    gid: input.gid,
    file_path: input.filePath,
    conflict_path: conflictPath,
    origin: input.origin,
    origin_label: input.originLabel ?? null,
    base_version: input.baseVersion ?? null,
    server_seq: input.serverSeq ?? null,
    local_content: localContent,
    remote_content: input.remoteContent,
    diff,
    additions,
    deletions,
    status: "unresolved",
    resolution: null,
    resolved_at: null,
    created_at: now,
  };
}

/**
 * Convenience helper: fork a conflict directly from a conflict-flagged Op.
 */
export function forkConflictFromOp(
  op: Op,
  dbHandle?: Database.Database,
  options?: { originLabel?: string; serverSeq?: number }
): ConflictRecord {
  const db = resolveDb(dbHandle);
  ensureConflictsTable(db);

  const payload = op.payload as {
    path?: string;
    rel_path?: string;
    content?: string;
    title?: string;
  };

  // Maps the origin machine's path onto this machine's data dir; throws UnappliableOpError when unsafe.
  const filePath = resolveSyncPath(payload.path, payload.rel_path);

  const remoteContent = typeof payload.content === "string" ? payload.content : "";

  let originLabel = options?.originLabel;
  if (!originLabel) {
    try {
      const clientRow = db
        .prepare("SELECT hostname FROM clients WHERE machine_id = ?")
        .get(op.origin) as { hostname: string } | undefined;
      originLabel = clientRow?.hostname;
    } catch {}
  }
  if (!originLabel) {
    originLabel = op.origin.slice(0, 8);
  }

  return registerConflict(
    {
      gid: op.gid,
      filePath,
      origin: op.origin,
      originLabel,
      baseVersion: op.base_version,
      serverSeq: options?.serverSeq,
      remoteContent,
      createdAt: op.created_at,
    },
    db
  );
}

// ---------------------------------------------------------------------------
// Conflict Queries
// ---------------------------------------------------------------------------

function rowToRecord(row: any, withDiff: boolean): ConflictRecord {
  const localContent = row.local_content ?? "";
  const remoteContent = row.remote_content ?? "";
  const stats = withDiff ? computeDiff(localContent, remoteContent) : null;

  return {
    id: row.id,
    gid: row.gid,
    file_path: row.file_path,
    conflict_path: row.conflict_path,
    origin: row.origin,
    origin_label: row.origin_label,
    base_version: row.base_version,
    server_seq: row.server_seq,
    local_content: localContent,
    remote_content: remoteContent,
    ...(stats ?? {}),
    status: row.status,
    resolution: row.resolution,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
  };
}

/**
 * List conflicts filtered by status. Defaults to unresolved conflicts.
 * Records omit diff/additions/deletions (computed only by getConflict/getConflictById).
 */
export function listConflicts(
  dbHandle?: Database.Database,
  options?: ListConflictsOptions
): ConflictRecord[] {
  const db = resolveDb(dbHandle);
  ensureConflictsTable(db);

  const status = options?.status ?? "unresolved";
  let query = "SELECT * FROM conflicts";
  const params: any[] = [];

  if (status !== "all") {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC, id DESC";

  if (options?.limit && Number.isInteger(options.limit) && options.limit > 0) {
    query += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(query).all(...params) as any[];
  return rows.map((r) => rowToRecord(r, false));
}

/**
 * Get active conflict by GID. If there is an unresolved conflict for this GID, returns it.
 * Otherwise returns the most recent resolved conflict, or null if none exist.
 */
export function getConflict(
  gid: string,
  dbHandle?: Database.Database
): ConflictRecord | null {
  const db = resolveDb(dbHandle);
  ensureConflictsTable(db);

  const row = db
    .prepare(
      `SELECT * FROM conflicts
       WHERE gid = ?
       ORDER BY (CASE WHEN status = 'unresolved' THEN 0 ELSE 1 END) ASC, created_at DESC, id DESC
       LIMIT 1`
    )
    .get(gid) as any;

  return row ? rowToRecord(row, true) : null;
}

/**
 * Get conflict by conflict row ID.
 */
export function getConflictById(
  id: number,
  dbHandle?: Database.Database
): ConflictRecord | null {
  const db = resolveDb(dbHandle);
  ensureConflictsTable(db);

  const row = db.prepare("SELECT * FROM conflicts WHERE id = ?").get(id) as any;
  return row ? rowToRecord(row, true) : null;
}

/**
 * Count active unresolved conflicts.
 */
export function countUnresolvedConflicts(dbHandle?: Database.Database): number {
  const db = resolveDb(dbHandle);
  ensureConflictsTable(db);

  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM conflicts WHERE status = 'unresolved'")
    .get() as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Conflict Resolution Engine (spec 1.7)
// ---------------------------------------------------------------------------

/**
 * Resolves a conflict using one of 4 deterministic strategies (spec 1.7):
 *   - `keep-server`: Accept remote state and delete conflict copy.
 *   - `keep-mine`: Re-assert local state, increment version, push to server, delete conflict copy.
 *   - `keep-both`: Retain canonical file and permanently keep the copy renamed as `<filename> (from <machine_label>).<ext>`.
 *   - `merged`: Apply user-provided custom merged text, delete conflict copy, and push merged update.
 */
export async function resolveConflict(
  gid: string,
  options: ResolveConflictOptions,
  dbHandle?: Database.Database
): Promise<ResolveConflictResult> {
  const db = resolveDb(dbHandle);
  ensureConflictsTable(db);

  const conflict = db
    .prepare("SELECT * FROM conflicts WHERE gid = ? AND status = 'unresolved' ORDER BY id DESC LIMIT 1")
    .get(gid) as any;

  if (!conflict) {
    throw new Error(`No unresolved conflict found for gid: ${gid}`);
  }

  const { strategy } = options;
  if (!["keep-server", "keep-mine", "keep-both", "merged"].includes(strategy)) {
    throw new Error(`Invalid resolution strategy: ${strategy}`);
  }

  if (strategy === "merged" && typeof options.mergedContent !== "string") {
    throw new Error("Merged resolution strategy requires mergedContent");
  }

  const machineId = readLocalMachineId(db);
  const now = Date.now();

  return await withLock(fileLockKey(conflict.file_path), async () => {
    let outboxOpId: number | undefined;
    let newFileGid: string | undefined;

    switch (strategy) {
      case "keep-server": {
        // Accept remote state: overwrite canonical file with remote content
        mkdirSync(dirname(conflict.file_path), { recursive: true });
        writeFileSync(conflict.file_path, conflict.remote_content, "utf8");

        const hash = sha256(conflict.remote_content);

        db.transaction(() => {
          db.prepare(`
            UPDATE files SET
              content_hash = ?,
              updated_at = datetime('now')
            WHERE gid = ?
          `).run(hash, conflict.gid);

          const file = db
            .prepare("SELECT id, title FROM files WHERE gid = ?")
            .get(conflict.gid) as { id: number; title: string } | undefined;

          if (file) {
            db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(file.id);
            db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(
              file.id,
              file.title,
              conflict.remote_content
            );
          }

          db.prepare(`
            UPDATE conflicts SET
              status = 'resolved',
              resolution = 'keep-server',
              resolved_at = ?
            WHERE id = ?
          `).run(now, conflict.id);
        })();

        // Delete conflict copy
        if (existsSync(conflict.conflict_path)) {
          try {
            rmSync(conflict.conflict_path, { force: true });
          } catch {}
        }
        break;
      }

      case "keep-mine": {
        // Re-assert the CURRENT canonical file (the registration snapshot may be stale)
        let mineContent: string = conflict.local_content;
        if (existsSync(conflict.file_path)) {
          try {
            mineContent = readFileSync(conflict.file_path, "utf-8");
          } catch {}
        } else {
          mkdirSync(dirname(conflict.file_path), { recursive: true });
          writeFileSync(conflict.file_path, mineContent, "utf8");
        }

        const hash = sha256(mineContent);

        db.transaction(() => {
          db.prepare(`
            UPDATE files SET
              content_hash = ?,
              updated_at = datetime('now')
            WHERE gid = ?
          `).run(hash, conflict.gid);

          const file = db
            .prepare("SELECT id, title FROM files WHERE gid = ?")
            .get(conflict.gid) as { id: number; title: string } | undefined;

          if (file) {
            db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(file.id);
            db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(
              file.id,
              file.title,
              mineContent
            );
          }

          // Enqueue update to push local state as canonical
          outboxOpId = enqueueOp(db, {
            gid: conflict.gid,
            kind: "file.update",
            origin: machineId,
            base_version: conflict.base_version ?? 0,
            payload: {
              path: conflict.file_path,
              rel_path: toRelPath(conflict.file_path) ?? undefined,
              title: file?.title ?? basename(conflict.file_path),
              content: mineContent,
              content_hash: hash,
            },
            created_at: now,
          });

          db.prepare(`
            UPDATE conflicts SET
              status = 'resolved',
              resolution = 'keep-mine',
              resolved_at = ?
            WHERE id = ?
          `).run(now, conflict.id);
        })();

        // Delete conflict copy
        if (existsSync(conflict.conflict_path)) {
          try {
            rmSync(conflict.conflict_path, { force: true });
          } catch {}
        }
        break;
      }

      case "keep-both": {
        // Retain canonical file AND permanently keep conflict copy as a new tracked file
        if (!existsSync(conflict.conflict_path)) {
          mkdirSync(dirname(conflict.conflict_path), { recursive: true });
          writeFileSync(conflict.conflict_path, conflict.remote_content, "utf8");
        }

        const copyHash = sha256(conflict.remote_content);
        const copyTitle = basename(conflict.conflict_path);

        db.transaction(() => {
          const canonicalFile = db
            .prepare("SELECT project_id, storage_type, content_class FROM files WHERE gid = ?")
            .get(conflict.gid) as
            | { project_id: number | null; storage_type: string; content_class: string | null }
            | undefined;

          const existingCopy = db
            .prepare("SELECT id, gid FROM files WHERE path = ?")
            .get(conflict.conflict_path) as { id: number; gid: string | null } | undefined;

          if (!existingCopy) {
            const insertRes = db.prepare(`
              INSERT INTO files (path, title, project_id, storage_type, content_class, source_path, content_hash)
              VALUES (?, ?, ?, ?, ?, NULL, ?)
            `).run(
              conflict.conflict_path,
              copyTitle,
              canonicalFile?.project_id ?? null,
              canonicalFile?.storage_type ?? "local",
              canonicalFile?.content_class ?? null,
              copyHash
            );
            const newId = Number(insertRes.lastInsertRowid);
            newFileGid = formatGid(newId, machineId);
            db.prepare("UPDATE files SET gid = ? WHERE id = ?").run(newFileGid, newId);

            db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(
              newId,
              copyTitle,
              conflict.remote_content
            );

            // Enqueue creation of the new file so it syncs to server
            outboxOpId = enqueueOp(db, {
              gid: newFileGid,
              kind: "file.create",
              origin: machineId,
              base_version: null,
              payload: {
                path: conflict.conflict_path,
                rel_path: toRelPath(conflict.conflict_path) ?? undefined,
                title: copyTitle,
                project_gid:
                  canonicalFile?.project_id == null
                    ? null
                    : ((db.prepare("SELECT gid FROM projects WHERE id = ?").get(canonicalFile.project_id) as
                        | { gid: string | null }
                        | undefined)?.gid ?? null),
                storage_type: canonicalFile?.storage_type ?? "local",
                content_class: canonicalFile?.content_class ?? null,
                content: conflict.remote_content,
                content_hash: copyHash,
              },
              created_at: now,
            });
          } else {
            newFileGid = existingCopy.gid ?? formatGid(existingCopy.id, machineId);
          }

          db.prepare(`
            UPDATE conflicts SET
              status = 'resolved',
              resolution = 'keep-both',
              resolved_at = ?
            WHERE id = ?
          `).run(now, conflict.id);
        })();
        break;
      }

      case "merged": {
        // Apply custom merged text to canonical file, push merged update, delete conflict copy
        const mergedText = options.mergedContent!;
        mkdirSync(dirname(conflict.file_path), { recursive: true });
        writeFileSync(conflict.file_path, mergedText, "utf8");

        const hash = sha256(mergedText);

        db.transaction(() => {
          db.prepare(`
            UPDATE files SET
              content_hash = ?,
              updated_at = datetime('now')
            WHERE gid = ?
          `).run(hash, conflict.gid);

          const file = db
            .prepare("SELECT id, title FROM files WHERE gid = ?")
            .get(conflict.gid) as { id: number; title: string } | undefined;

          if (file) {
            db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(file.id);
            db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(
              file.id,
              file.title,
              mergedText
            );
          }

          // Enqueue merged update to server
          outboxOpId = enqueueOp(db, {
            gid: conflict.gid,
            kind: "file.update",
            origin: machineId,
            base_version: conflict.base_version ?? 0,
            payload: {
              path: conflict.file_path,
              rel_path: toRelPath(conflict.file_path) ?? undefined,
              title: file?.title ?? basename(conflict.file_path),
              content: mergedText,
              content_hash: hash,
            },
            created_at: now,
          });

          db.prepare(`
            UPDATE conflicts SET
              status = 'resolved',
              resolution = 'merged',
              resolved_at = ?
            WHERE id = ?
          `).run(now, conflict.id);
        })();

        // Delete conflict copy
        if (existsSync(conflict.conflict_path)) {
          try {
            rmSync(conflict.conflict_path, { force: true });
          } catch {}
        }
        break;
      }
    }

    return {
      success: true,
      gid: conflict.gid,
      strategy,
      resolvedAt: now,
      outboxOpId,
      newFileGid,
    };
  });
}
