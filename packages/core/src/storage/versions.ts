import type { Database } from "better-sqlite3";

const CHUNK = 500;

/** The server version of `gid` this machine has seen (0 when unknown). */
export function knownGidVersion(db: Database, gid: string): number {
  const row = db.prepare("SELECT version FROM gid_versions WHERE gid = ?").get(gid) as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/** Known versions for many gids in a few queries; unknown gids are absent from the map. */
export function knownGidVersions(db: Database, gids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < gids.length; i += CHUNK) {
    const slice = gids.slice(i, i + CHUNK);
    const ph = slice.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT gid, version FROM gid_versions WHERE gid IN (${ph})`)
      .all(...slice) as Array<{ gid: string; version: number }>;
    for (const r of rows) out.set(r.gid, r.version);
  }
  return out;
}

/** Record a server-reported gid version; monotonic. */
export function recordGidVersion(db: Database, gid: string, version: number): void {
  db.prepare(
    `INSERT INTO gid_versions (gid, version) VALUES (?, ?)
     ON CONFLICT(gid) DO UPDATE SET version = MAX(version, excluded.version)`,
  ).run(gid, version);
}

/** An own op for `gid` was acked, so every later unsent op for it is now based one version higher. */
export function bumpPendingBases(db: Database, gid: string, ackedOutboxId: number): void {
  db.prepare(
    `UPDATE outbox SET base_version = base_version + 1
     WHERE gid = ? AND id > ? AND status IN ('pending', 'failed') AND base_version IS NOT NULL`,
  ).run(gid, ackedOutboxId);
}

/** Remember that this machine's own content push for `gid` was flagged conflict by the server. */
export function markLostPush(db: Database, gid: string): void {
  db.prepare(
    `INSERT INTO gid_versions (gid, version, lost_push) VALUES (?, 0, 1)
     ON CONFLICT(gid) DO UPDATE SET lost_push = 1`,
  ).run(gid);
}

export function clearLostPush(db: Database, gid: string): void {
  db.prepare("UPDATE gid_versions SET lost_push = 0 WHERE gid = ?").run(gid);
}

export function hasLostPush(db: Database, gid: string): boolean {
  const row = db.prepare("SELECT lost_push FROM gid_versions WHERE gid = ?").get(gid) as
    | { lost_push: number }
    | undefined;
  return row?.lost_push === 1;
}
