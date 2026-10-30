import type { Database } from "better-sqlite3";
import { OP_KINDS, kindFamily, type KindFamily, type OpKind } from "./op.js";

const CHUNK = 500;

/** The server versions each record per kind family, so this machine tracks `(gid, family)` the same way. */
export function versionKey(gid: string, family: KindFamily | string): string {
  return `${gid}|${family}`;
}

/** The server version of `gid`'s `family` this machine has seen (0 when unknown). */
export function knownGidVersion(db: Database, gid: string, family: KindFamily | string): number {
  const row = db.prepare("SELECT version FROM gid_versions WHERE gid = ? AND family = ?").get(gid, family) as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/** Known versions for many gids in a few queries, keyed by {@link versionKey}; unknown pairs are absent. */
export function knownGidVersions(db: Database, gids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < gids.length; i += CHUNK) {
    const slice = gids.slice(i, i + CHUNK);
    const ph = slice.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT gid, family, version FROM gid_versions WHERE gid IN (${ph})`)
      .all(...slice) as Array<{ gid: string; family: string; version: number }>;
    for (const r of rows) out.set(versionKey(r.gid, r.family), r.version);
  }
  return out;
}

/** Record a server-reported version; monotonic. */
export function recordGidVersion(db: Database, gid: string, family: KindFamily | string, version: number): void {
  db.prepare(
    `INSERT INTO gid_versions (gid, family, version) VALUES (?, ?, ?)
     ON CONFLICT(gid, family) DO UPDATE SET version = MAX(version, excluded.version)`,
  ).run(gid, family, version);
}

/** An own op for (gid, family) was accepted, so every later unsent op of that family is now based one version higher. */
export function bumpPendingBases(db: Database, gid: string, family: KindFamily | string, ackedOutboxId: number): void {
  const kinds = OP_KINDS.filter((k: OpKind) => kindFamily(k) === family);
  if (kinds.length === 0) return;
  const ph = kinds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE outbox SET base_version = base_version + 1
     WHERE gid = ? AND id > ? AND kind IN (${ph}) AND status IN ('pending', 'failed') AND base_version IS NOT NULL`,
  ).run(gid, ackedOutboxId, ...kinds);
}

/** Remember that this machine's own content push for `gid` was flagged conflict by the server. */
export function markLostPush(db: Database, gid: string): void {
  db.prepare(
    `INSERT INTO gid_versions (gid, family, version, lost_push) VALUES (?, 'content', 0, 1)
     ON CONFLICT(gid, family) DO UPDATE SET lost_push = 1`,
  ).run(gid);
}

export function clearLostPush(db: Database, gid: string): void {
  db.prepare("UPDATE gid_versions SET lost_push = 0 WHERE gid = ? AND family = 'content'").run(gid);
}

export function hasLostPush(db: Database, gid: string): boolean {
  const row = db.prepare("SELECT lost_push FROM gid_versions WHERE gid = ? AND family = 'content'").get(gid) as
    | { lost_push: number }
    | undefined;
  return row?.lost_push === 1;
}
