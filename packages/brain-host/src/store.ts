import type Database from "better-sqlite3";

/** Ops whose acceptance deletes a record: the gid's other kept ops go and a tombstone stays. */
const TOMBSTONE_KINDS = new Set(["file.delete", "project.unregister"]);

export interface NewOp {
  gid: string;
  kind: string;
  origin: string;
  base_version: number | null;
  payloadJson: string;
  created_at: number;
  client_seq: number | null;
}

export interface OpRow {
  seq: number;
  gid: string;
  kind: string;
  origin: string;
  base_version: number | null;
  payload: unknown;
  created_at: number;
  client_seq: number | null;
  status: "accepted" | "conflict";
  received_at: number;
  gid_version: number;
}

export interface SnapshotGid {
  gid: string;
  records: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
}

/** Every query takes the brain id first; no method can reach another brain's rows. */
export class BrainStore {
  constructor(private readonly db: Database.Database) {}

  createBrain(shareHash: string, name: string): number {
    const r = this.db
      .prepare("INSERT INTO brains (share_hash, name, created_at) VALUES (?, ?, ?)")
      .run(shareHash, name, Date.now());
    return Number(r.lastInsertRowid);
  }

  findBrainByShareHash(shareHash: string): { id: number; name: string } | null {
    return (
      (this.db.prepare("SELECT id, name FROM brains WHERE share_hash = ?").get(shareHash) as
        | { id: number; name: string }
        | undefined) ?? null
    );
  }

  getBrain(brainId: number): { id: number; name: string } | null {
    return (
      (this.db.prepare("SELECT id, name FROM brains WHERE id = ?").get(brainId) as
        | { id: number; name: string }
        | undefined) ?? null
    );
  }

  renameBrain(brainId: number, name: string): void {
    this.db.prepare("UPDATE brains SET name = ? WHERE id = ?").run(name, brainId);
  }

  enrollMachine(brainId: number, machineId: string, hostname: string | null, tokenHash: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO clients (brain_id, machine_id, hostname, token_hash, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(brainId, machineId, hostname, tokenHash, now, now);
  }

  hasMachine(brainId: number, machineId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM clients WHERE brain_id = ? AND machine_id = ?").get(brainId, machineId) !==
      undefined
    );
  }

  /** Replace a machine's token (re-join); the old token stops working. */
  rotateToken(brainId: number, machineId: string, tokenHash: string, hostname: string | null): void {
    this.db
      .prepare(
        `UPDATE clients SET token_hash = ?, hostname = COALESCE(?, hostname), last_seen_at = ?
         WHERE brain_id = ? AND machine_id = ?`,
      )
      .run(tokenHash, hostname, Date.now(), brainId, machineId);
  }

  revokeMachine(brainId: number, machineId: string): boolean {
    return (
      this.db.prepare("DELETE FROM clients WHERE brain_id = ? AND machine_id = ?").run(brainId, machineId)
        .changes > 0
    );
  }

  listMachines(brainId: number): Array<{ machine_id: string; hostname: string | null; last_seen_at: number; acked_seq: number }> {
    return this.db
      .prepare(
        `SELECT machine_id, hostname, last_seen_at, acked_seq FROM clients
         WHERE brain_id = ? ORDER BY last_seen_at DESC, machine_id ASC`,
      )
      .all(brainId) as never;
  }

  touchMachine(brainId: number, machineId: string, ackedSeq?: number): void {
    this.db
      .prepare(
        `UPDATE clients SET last_seen_at = ?, acked_seq = MAX(acked_seq, COALESCE(?, 0))
         WHERE brain_id = ? AND machine_id = ?`,
      )
      .run(Date.now(), ackedSeq ?? null, brainId, machineId);
  }

  /** The accepted version of a record family; 0 when nothing was accepted yet. */
  currentVersion(brainId: number, gid: string, family: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM records WHERE brain_id = ? AND gid = ? AND kind_family = ?")
      .get(brainId, gid, family) as { v: number | null };
    return row.v ?? 0;
  }

  /** Append an op, keeping `records` and `conflicts` consistent. Call inside a transaction for a batch. */
  appendOp(
    brainId: number,
    op: NewOp,
    family: string,
    status: "accepted" | "conflict",
  ): { seq: number; version: number } {
    const before = this.currentVersion(brainId, op.gid, family);
    const info = this.db
      .prepare(
        `INSERT INTO ops (brain_id, gid, kind, kind_family, origin, base_version, payload, created_at, client_seq, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(brainId, op.gid, op.kind, family, op.origin, op.base_version, op.payloadJson, op.created_at, op.client_seq, status);
    const seq = Number(info.lastInsertRowid);

    if (status === "conflict") {
      this.db
        .prepare(
          `INSERT INTO conflicts (brain_id, seq, gid, kind, kind_family, origin, base_version, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(brainId, seq, op.gid, op.kind, family, op.origin, op.base_version, op.payloadJson, op.created_at);
      return { seq, version: before };
    }

    const version = before + 1;
    const tombstone = TOMBSTONE_KINDS.has(op.kind) ? 1 : 0;
    if (tombstone) this.db.prepare("DELETE FROM records WHERE brain_id = ? AND gid = ?").run(brainId, op.gid);
    this.db
      .prepare(
        `INSERT INTO records (brain_id, gid, kind, kind_family, version, payload, origin, deleted, last_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(brain_id, gid, kind) DO UPDATE SET
           version = excluded.version, payload = excluded.payload, origin = excluded.origin,
           deleted = excluded.deleted, last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
      )
      .run(brainId, op.gid, op.kind, family, version, op.payloadJson, op.origin, tombstone, seq, Date.now());
    // An accepted op based on at least a parked conflict's version is what a resolution looks like (an in-batch loser shares the resolver's base).
    if (op.base_version !== null) {
      this.db
        .prepare(
          `DELETE FROM conflicts WHERE brain_id = ? AND gid = ? AND kind_family = ? AND (base_version IS NULL OR base_version <= ?)`,
        )
        .run(brainId, op.gid, family, op.base_version);
    }
    return { seq, version };
  }

  findByClientSeq(
    brainId: number,
    origin: string,
    clientSeq: number,
  ): { seq: number; status: "accepted" | "conflict"; version: number } | null {
    const row = this.db
      .prepare("SELECT seq, gid, kind_family, status FROM ops WHERE brain_id = ? AND origin = ? AND client_seq = ?")
      .get(brainId, origin, clientSeq) as
      | { seq: number; gid: string; kind_family: string; status: "accepted" | "conflict" }
      | undefined;
    if (!row) return null;
    return { seq: row.seq, status: row.status, version: this.versionAt(brainId, row.gid, row.kind_family, row.seq) };
  }

  /** Accepted ops of the record family up to and including `seq`: the version right after that op. */
  private versionAt(brainId: number, gid: string, family: string, seq: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ops
         WHERE brain_id = ? AND gid = ? AND kind_family = ? AND status = 'accepted' AND seq <= ?`,
      )
      .get(brainId, gid, family, seq) as { n: number };
    return row.n;
  }

  opsSince(brainId: number, since: number, limit: number): OpRow[] {
    const rows = this.db
      .prepare(
        `SELECT seq, gid, kind, kind_family, origin, base_version, payload, created_at, client_seq, status, received_at
         FROM ops WHERE brain_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(brainId, since, limit) as Array<Record<string, unknown> & { kind_family: string; gid: string; seq: number; payload: string }>;
    return rows.map((r) => {
      const { kind_family, ...rest } = r;
      return {
        ...(rest as unknown as Omit<OpRow, "payload" | "gid_version">),
        payload: JSON.parse(r.payload),
        gid_version: this.versionAt(brainId, r.gid, kind_family, r.seq),
      };
    });
  }

  latestSeq(brainId: number): number {
    const row = this.db.prepare("SELECT MAX(seq) AS s FROM ops WHERE brain_id = ?").get(brainId) as { s: number | null };
    return row.s ?? 0;
  }

  /** One page of current state, paged by gid. `full` includes payloads; the index keeps only each payload's content_hash. */
  snapshotPage(
    brainId: number,
    afterGid: string,
    limit: number,
    full: boolean,
  ): { gids: SnapshotGid[]; next: string | null } {
    const gids = (
      this.db
        .prepare(
          `SELECT gid FROM (
             SELECT gid FROM records WHERE brain_id = ? AND gid > ?
             UNION SELECT gid FROM conflicts WHERE brain_id = ? AND gid > ?
           ) ORDER BY gid LIMIT ?`,
        )
        .all(brainId, afterGid, brainId, afterGid, limit) as Array<{ gid: string }>
    ).map((r) => r.gid);

    const recStmt = this.db.prepare(
      `SELECT gid, kind, kind_family, version, payload, origin, deleted, last_seq, updated_at
       FROM records WHERE brain_id = ? AND gid = ? ORDER BY last_seq ASC`,
    );
    const confStmt = this.db.prepare(
      `SELECT seq, gid, kind, kind_family, origin, base_version, payload, created_at
       FROM conflicts WHERE brain_id = ? AND gid = ? ORDER BY seq ASC`,
    );
    const shape = (payload: string): Record<string, unknown> => {
      const parsed = JSON.parse(payload) as unknown;
      if (full) return { payload: parsed };
      const hash =
        parsed && typeof parsed === "object" && typeof (parsed as { content_hash?: unknown }).content_hash === "string"
          ? (parsed as { content_hash: string }).content_hash
          : null;
      return { content_hash: hash };
    };

    const out: SnapshotGid[] = gids.map((gid) => ({
      gid,
      records: (recStmt.all(brainId, gid) as Array<Record<string, unknown> & { payload: string }>).map((r) => ({
        seq: r.last_seq,
        gid: r.gid,
        kind: r.kind,
        kind_family: r.kind_family,
        version: r.version,
        origin: r.origin,
        deleted: r.deleted === 1,
        created_at: r.updated_at,
        base_version: null,
        ...shape(r.payload),
      })),
      conflicts: (confStmt.all(brainId, gid) as Array<Record<string, unknown> & { payload: string }>).map((r) => ({
        seq: r.seq,
        gid: r.gid,
        kind: r.kind,
        kind_family: r.kind_family,
        origin: r.origin,
        base_version: r.base_version,
        created_at: r.created_at,
        ...shape(r.payload),
      })),
    }));
    return { gids: out, next: gids.length === limit ? gids[gids.length - 1] : null };
  }
}
