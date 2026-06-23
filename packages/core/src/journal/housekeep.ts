// packages/core/src/journal/housekeep.ts
import { readdirSync, statSync, unlinkSync, renameSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../db/index.js";
import { readHighWater } from "./high-water.js";

export interface HousekeepConfig {
  baseDir: string;            // <data>/knowledge/journal
  projectSlug: string;
  retention: {
    raw_days: number;            // 0 = forever
    mechanical_only_days: number;
    narrative_days: number;
    archive_cold_after_days: number;
    purge_archived_after_days: number;
  };
  graceDays?: number;            // default 7 (unused in v1; reserved for two-step grace)
  now?: Date;
}

export interface HousekeepResult {
  raw_files_pruned: number;
  raw_files_skipped_undistilled: number;
  archived_tasks: number;
  pending_deletions_marked: number;
  purged: number;
}

/**
 * Read the timestamp of the LAST event in a JSONL file. Events are append-only
 * and chronological per writer, so the last line is the newest. Returns null
 * if the file is empty or unreadable.
 */
function lastEventTs(path: string): string | null {
  try {
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return typeof last.ts === "string" ? last.ts : null;
  } catch {
    return null;
  }
}

export function housekeepJournal(cfg: HousekeepConfig): HousekeepResult {
  const now = cfg.now ?? new Date();
  const result: HousekeepResult = {
    raw_files_pruned: 0,
    raw_files_skipped_undistilled: 0,
    archived_tasks: 0,
    pending_deletions_marked: 0,
    purged: 0,
  };

  // 1. Prune raw .jsonl past retention — but never delete a file containing
  // events newer than the high-water mark (those events haven't been
  // distilled yet, so deleting them = irrecoverable data loss).
  if (cfg.retention.raw_days > 0) {
    const cutoff = now.getTime() - cfg.retention.raw_days * 86400_000;
    const rawDir = join(cfg.baseDir, cfg.projectSlug, "raw");
    if (existsSync(rawDir)) {
      const hw = readHighWater(cfg.baseDir, cfg.projectSlug);
      const highWaterTs = hw?.last_event_ts ?? null;
      for (const f of readdirSync(rawDir).filter((n) => n.endsWith(".jsonl"))) {
        const p = join(rawDir, f);
        if (statSync(p).mtimeMs >= cutoff) continue;

        // Refuse to prune if any event in the file is past the high-water mark.
        // No high-water at all = nothing has been distilled = refuse all deletes.
        const fileLastTs = lastEventTs(p);
        if (highWaterTs === null || fileLastTs === null || fileLastTs > highWaterTs) {
          result.raw_files_skipped_undistilled++;
          continue;
        }
        unlinkSync(p);
        result.raw_files_pruned++;
      }
    }
  }

  // 2. Archive cold tasks
  if (cfg.retention.archive_cold_after_days > 0) {
    const archiveCutoff = new Date(now.getTime() - cfg.retention.archive_cold_after_days * 86400_000).toISOString();
    const db = getDatabase();
    const cold = db.prepare(`
      SELECT jm.file_id, f.path FROM journal_meta jm
      JOIN files f ON f.id = jm.file_id
      JOIN projects p ON p.id = jm.project_id
      WHERE p.slug = ? AND jm.last_active_at < ?
    `).all(cfg.projectSlug, archiveCutoff) as Array<{ file_id: number; path: string }>;
    const archiveDir = join(cfg.baseDir, cfg.projectSlug, "_archive");
    mkdirSync(archiveDir, { recursive: true });
    for (const row of cold) {
      const dest = join(archiveDir, row.path.split("/").pop() ?? `task-${row.file_id}.md`);
      if (!existsSync(dest) && existsSync(row.path)) {
        try {
          renameSync(row.path, dest);
        } catch (err: any) {
          if (err?.code === "EXDEV") {
            // Cross-device: _archive/ sits on a different mount than the
            // source. Fall back to copy + unlink so a single mis-located
            // archive dir doesn't abort the whole housekeep run.
            try {
              const buf = readFileSync(row.path);
              writeFileSync(dest, buf);
              unlinkSync(row.path);
            } catch (copyErr) {
              console.warn(`[housekeep] EXDEV copy fallback failed for ${row.path}:`, copyErr);
              continue;
            }
          } else {
            console.warn(`[housekeep] archive failed for ${row.path}:`, err);
            continue;
          }
        }
        db.prepare(`UPDATE files SET path = ? WHERE id = ?`).run(dest, row.file_id);
        result.archived_tasks++;
      }
    }
  }

  return result;
}
