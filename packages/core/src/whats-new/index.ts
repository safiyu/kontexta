import { getDatabase } from "../db/index.js";
import { getTagsForFiles } from "../metadata/index.js";
import type { FileRecord } from "../types.js";

export type ChangeKind = "created" | "modified";

export interface WhatsNewOptions {
  /**
   * Cutoff. Either:
   *   - ISO 8601 timestamp ("2026-04-30T12:00:00Z")
   *   - Relative duration ("30s", "15m", "2h", "1d", "7d", "1w")
   * Records with updated_at >= since are returned.
   */
  since: string;
  project_id?: number | null;
  /** If true, fetch and attach tags[] for each file. Default true. */
  include_tags?: boolean;
  /** Max rows to return. Default 200. */
  limit?: number;
}

export interface WhatsNewEntry extends FileRecord {
  change: ChangeKind;
  tags?: string[];
}

export interface WhatsNewResult {
  /** Resolved cutoff as ISO timestamp. */
  since: string;
  /** Server "now" at query time, ISO. */
  until: string;
  count: number;
  files: WhatsNewEntry[];
}

const DURATION_RE = /^\s*(\d+)\s*(s|m|h|d|w)\s*$/i;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve `since` (ISO timestamp OR relative duration) to a sqlite-comparable
 * UTC datetime string ("YYYY-MM-DD HH:MM:SS"). Throws RangeError if unparseable
 * or if the resulting time is in the future.
 */
export function resolveSince(since: string, now: Date = new Date()): string {
  const trimmed = since.trim();
  if (!trimmed) throw new RangeError("`since` is required");

  const dur = DURATION_RE.exec(trimmed);
  let cutoff: Date;
  if (dur) {
    const n = parseInt(dur[1], 10);
    const unit = dur[2].toLowerCase();
    cutoff = new Date(now.getTime() - n * UNIT_MS[unit]);
  } else {
    const t = Date.parse(trimmed);
    if (Number.isNaN(t)) {
      throw new RangeError(
        `Cannot parse \`since\`: ${JSON.stringify(since)}. Expected ISO 8601 timestamp or relative duration like "1h", "7d", "2w".`
      );
    }
    cutoff = new Date(t);
  }

  if (cutoff.getTime() > now.getTime()) {
    throw new RangeError(`\`since\` is in the future: ${cutoff.toISOString()}`);
  }
  return toSqliteTime(cutoff);
}

function toSqliteTime(d: Date): string {
  // sqlite stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC.
  // Comparisons in our tables expect that exact shape.
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function whatsNew(opts: WhatsNewOptions): WhatsNewResult {
  const now = new Date();
  const cutoff = resolveSince(opts.since, now);
  const limit = opts.limit ?? 200;
  const includeTags = opts.include_tags !== false;

  const db = getDatabase();
  let sql = `
    SELECT *,
      CASE WHEN created_at >= ? THEN 'created' ELSE 'modified' END AS change
    FROM files
    WHERE updated_at >= ?
  `;
  const params: unknown[] = [cutoff, cutoff];

  if (opts.project_id !== undefined) {
    if (opts.project_id === null) {
      sql += " AND project_id IS NULL";
    } else {
      sql += " AND project_id = ?";
      params.push(opts.project_id);
    }
  }

  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as (FileRecord & { change: ChangeKind })[];

  let entries: WhatsNewEntry[] = rows;
  if (includeTags && rows.length > 0) {
    const tagMap = getTagsForFiles(rows.map((r) => r.id));
    entries = rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
  }

  return {
    since: new Date(cutoff.replace(" ", "T") + "Z").toISOString(),
    until: now.toISOString(),
    count: entries.length,
    files: entries,
  };
}
