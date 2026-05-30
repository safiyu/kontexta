import { getDatabase } from "../db/index.js";

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
    clearTouches.run(input.file_id);
    for (const t of input.touched_files) insertTouch.run(input.file_id, t);
    clearRefs.run(input.file_id);
    for (const r of input.git_refs) insertRef.run(input.file_id, r.ref_type, r.ref_value);
  })();
}

export function journalMetaForFile(file_id: number): JournalMetaRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM journal_meta WHERE file_id = ?`)
    .get(file_id) as any;
  if (!row) return null;
  return {
    ...row,
    touched_files: JSON.parse(row.touched_files),
    raw_sources: JSON.parse(row.raw_sources),
  };
}

export function openTasksForProject(project_id: number, openWindowDays: number): JournalMetaRow[] {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - openWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM journal_meta WHERE project_id = ? AND last_active_at >= ? ORDER BY last_active_at DESC`,
    )
    .all(project_id, cutoff) as any[];
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
