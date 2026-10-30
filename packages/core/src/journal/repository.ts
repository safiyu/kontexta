import { getDatabase } from "../db/index.js";
import { formatGid } from "../identity/gid.js";
import { getMachineId } from "../identity/machine.js";
import { enqueueOp } from "../storage/outbox.js";
import { inRemoteApply } from "../storage/apply.js";
import type { Op } from "../storage/op.js";
import { gidOfRow } from "../storage/gids.js";

/**
 * Append a journal-mutation op to the outbox — UNLESS we are applying a remote
 * op.
 *
 * Echo suppression, layer 1 (spec 1.4): when a remote op is being applied
 * locally, `applyRemoteOp` runs inside the `applyScope` remote-apply scope. In
 * that case the write routine must persist to DB but NOT enqueue an outbound
 * op (or the change would echo back to the server and loop). On the normal
 * local-write path `inRemoteApply()` is false and the op is appended.
 *
 * Callers invoke this INSIDE their write transaction so the op commits or rolls
 * back atomically with the write (spec 1.3). Mirrors the files module's
 * `enqueueFileOp` (M54) and the metadata module's `enqueueMetadataOp` (M55).
 */
function enqueueJournalOp(op: Op): void {
  if (inRemoteApply()) return;
  enqueueOp(getDatabase(), op);
}

/**
 * The global id of the `journal_meta` row for `fileId` — read from the row, not
 * recomputed (so a locally-updated REMOTE journal keeps its remote origin in the
 * gid). `journal_meta` is keyed on `file_id` (its PK), so the gid is
 * `<file_id>@<machine_id>`; falls back to the local gid if the row pre-dates
 * migration 013 (no gid stamped).
 */
function journalGid(fileId: number): string {
  const row = getDatabase()
    .prepare(`SELECT gid FROM journal_meta WHERE file_id = ?`)
    .get(fileId) as { gid: string | null } | undefined;
  return row?.gid ?? formatGid(fileId, getMachineId());
}

export interface UpsertJournalMetaInput {
  file_id: number;
  project_id: number;
  task_slug: string;
  status_latest?: string | null;
  started_at: string;
  last_active_at: string;
  touched_files: string[];
  raw_sources: string[];
  git_refs: Array<{ ref_type: "branch" | "commit" | "ticket"; ref_value: string }>;
}

export interface JournalMetaRow {
  file_id: number;
  project_id: number;
  task_slug: string;
  status_latest: string | null;
  started_at: string;
  last_active_at: string;
  touched_files: string[];
  raw_sources: string[];
}

export function upsertJournalMeta(input: UpsertJournalMetaInput): void {
  const db = getDatabase();

  const upsert = db.prepare(`
    INSERT INTO journal_meta (
      file_id, project_id, task_slug, status_latest, started_at, last_active_at, touched_files, raw_sources
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET
      task_slug      = excluded.task_slug,
      status_latest  = excluded.status_latest,
      last_active_at = excluded.last_active_at,
      touched_files  = excluded.touched_files,
      raw_sources    = excluded.raw_sources
  `);

  const clearTouches = db.prepare(`DELETE FROM journal_touches WHERE file_id = ?`);
  const insertTouch = db.prepare(`INSERT OR IGNORE INTO journal_touches (file_id, touched_path) VALUES (?, ?)`);

  const clearRefs = db.prepare(`DELETE FROM journal_git_refs WHERE file_id = ?`);
  const insertRef = db.prepare(`INSERT OR IGNORE INTO journal_git_refs (file_id, ref_type, ref_value) VALUES (?, ?, ?)`);

  // Capture the pre-upsert presence so we can tell a FRESH record (pre is undefined →
  // base_version null, no prior version) from an update (existing record →
  // base_version 0) once the upsert has run.
  const pre = db
    .prepare(`SELECT gid FROM journal_meta WHERE file_id = ?`)
    .get(input.file_id) as { gid: string | null } | undefined;
  const isCreate = !pre;

  db.transaction(() => {
    upsert.run(
      input.file_id,
      input.project_id,
      input.task_slug,
      input.status_latest ?? null,
      input.started_at,
      input.last_active_at,
      JSON.stringify(input.touched_files),
      JSON.stringify(input.raw_sources),
    );
    // The upsert cannot report insert-vs-update, so stamp the gid only when the
    // row's gid is still NULL (a fresh row). Keyed on file_id (this table's PK),
    // matching the migration-013 backfill. An existing row already carries a
    // gid (backfill or an earlier upsert) and is left untouched.
    const gidRow = db
      .prepare(`SELECT gid FROM journal_meta WHERE file_id = ?`)
      .get(input.file_id) as { gid: string | null } | undefined;
    if (gidRow && gidRow.gid === null) {
      db.prepare(`UPDATE journal_meta SET gid = ? WHERE file_id = ?`).run(formatGid(input.file_id, getMachineId()), input.file_id);
    }
    clearTouches.run(input.file_id);
    for (const t of input.touched_files) insertTouch.run(input.file_id, t);
    clearRefs.run(input.file_id);
    for (const r of input.git_refs) insertRef.run(input.file_id, r.ref_type, r.ref_value);

    // Enqueue the upsert atomically with the write (spec 1.3); no-op while
    // applying a remote op (echo suppression, spec 1.4). base_version is null
    // for a fresh journal record and 0 when updating an existing one.
    enqueueJournalOp({
      gid: journalGid(input.file_id),
      kind: "journal.meta.upsert",
      origin: getMachineId(),
      base_version: isCreate ? null : 0,
      payload: {
        project_gid: gidOfRow("projects", input.project_id),
        task_slug: input.task_slug,
        status_latest: input.status_latest ?? null,
        started_at: input.started_at,
        last_active_at: input.last_active_at,
        touched_files: input.touched_files,
        raw_sources: input.raw_sources,
        git_refs: input.git_refs,
      },
      created_at: Date.now(),
    });
  })();
}

interface RawJournalMetaRow {
  file_id: number;
  project_id: number;
  task_slug: string;
  status_latest: string | null;
  started_at: string;
  last_active_at: string;
  touched_files: string;
  raw_sources: string;
}

export function journalMetaForFile(file_id: number): JournalMetaRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM journal_meta WHERE file_id = ?`)
    .get(file_id) as RawJournalMetaRow | undefined;
  if (!row) return null;
  return {
    ...row,
    touched_files: JSON.parse(row.touched_files),
    raw_sources: JSON.parse(row.raw_sources),
  };
}

export function openTasksForProject(
  project_id: number,
  openWindowDays: number,
  now: Date = new Date(),
): JournalMetaRow[] {
  const db = getDatabase();
  const cutoff = new Date(now.getTime() - openWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM journal_meta WHERE project_id = ? AND last_active_at >= ? ORDER BY last_active_at DESC`,
    )
    .all(project_id, cutoff) as RawJournalMetaRow[];
  return rows.map((row) => ({
    ...row,
    touched_files: JSON.parse(row.touched_files),
    raw_sources: JSON.parse(row.raw_sources),
  }));
}

export function journalRefsByValue(
  ref_type: "branch" | "commit" | "ticket",
  ref_value: string,
): number[] {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT file_id FROM journal_git_refs WHERE ref_type = ? AND ref_value = ?`)
    .all(ref_type, ref_value) as Array<{ file_id: number }>;
  return rows.map((r) => r.file_id);
}

export function markUpgradeApplied(file_id: number, status_latest: string | null): void {
  const db = getDatabase();
  const pre = db
    .prepare(`SELECT gid FROM journal_meta WHERE file_id = ?`)
    .get(file_id) as { gid: string | null } | undefined;
  if (!pre) return;

  db.transaction(() => {
    db.prepare(`UPDATE journal_meta SET status_latest = ? WHERE file_id = ?`)
      .run(status_latest, file_id);

    const full = journalMetaForFile(file_id);
    if (!full) return;
    const refsMap = gitRefsForFiles([file_id]);
    const refs = (refsMap.get(file_id) ?? []) as Array<{ ref_type: "branch" | "commit" | "ticket"; ref_value: string }>;

    enqueueJournalOp({
      gid: journalGid(file_id),
      kind: "journal.meta.upsert",
      origin: getMachineId(),
      base_version: 0,
      payload: {
        project_gid: gidOfRow("projects", full.project_id),
        task_slug: full.task_slug,
        status_latest: full.status_latest,
        started_at: full.started_at,
        last_active_at: full.last_active_at,
        touched_files: full.touched_files,
        raw_sources: full.raw_sources,
        git_refs: refs,
      },
      created_at: Date.now(),
    });
  })();
}

export function gitRefsForFiles(fileIds: number[]): Map<number, Array<{ ref_type: string; ref_value: string }>> {
  const out = new Map<number, Array<{ ref_type: string; ref_value: string }>>();
  if (fileIds.length === 0) return out;
  const rows = getDatabase()
    .prepare(`SELECT file_id, ref_type, ref_value FROM journal_git_refs WHERE file_id IN (${fileIds.map(() => "?").join(",")})`)
    .all(...fileIds) as Array<{ file_id: number; ref_type: string; ref_value: string }>;
  for (const r of rows) {
    const list = out.get(r.file_id) ?? [];
    list.push({ ref_type: r.ref_type, ref_value: r.ref_value });
    out.set(r.file_id, list);
  }
  return out;
}
