/**
 * Outbox queue — Phase 3 (storage/03-outbox).
 *
 * A thin, transactional layer over the `outbox` table (migration 014). Every
 * local write appends one {@link Op}; the Phase 4 sync loop drains `pending`
 * ops in local-seq order, marks them `sent`, then `acked` (recording the
 * server-assigned global seq) or `failed` (recording an attempt count + backoff
 * retry time).
 *
 * Design invariants (pinned by the TDD contract in tests/storage/outbox.test.ts):
 *
 *   APPEND-ONLY  — `enqueueOp` appends exactly one row and returns its local
 *   seq (the outbox.id / AUTOINCREMENT). Local seq is the only local ordering
 *   signal; created_at is never used to order.
 *
 *   TRANSACTIONAL — `enqueueOp` reuses the caller's open transaction (spec 1.3:
 *   the op is appended "within the same SQLite transaction" as the write). A
 *   rolled-back caller transaction discards the op; a committed one persists
 *   it. It never commits the caller's transaction on its own.
 *
 *   STRICT  — `enqueueOp` validates the op via {@link parseOp} before insert and
 *   throws on a malformed op, so it never enqueues a corrupt row.
 *
 *   STATE MACHINE  — pending -> sent -> acked | failed. Each transition is
 *   observable on the row's status / server_seq / attempts / next_attempt_at /
 *   last_error columns. Every mark* is a natural no-op for an unknown id (it
 *   matches no row, so it throws nothing); markSent/markFailed only move a row
 *   out of a non-terminal state, and markAcked (terminal) leaves an already-
 *   acked row untouched.
 *
 * All functions take an explicit `db` handle (the caller owns the connection —
 * matching the repo's `getDatabase()`-passing style) so they compose with the
 * caller's transactions rather than reaching for the shared singleton.
 */

import Database from "better-sqlite3";
import { parseOp, type Op } from "./op.js";
import { knownGidVersion } from "./versions.js";

/** One row of the `outbox` table (the delivery-state columns the queue owns). */
interface OutboxRow {
  id: number;
  gid: string;
  kind: string;
  origin: string;
  base_version: number | null;
  payload: string;
  created_at: number;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  server_seq: number | null;
}

/** A pending op plus the local seq (id) that orders it in the queue. */
export interface PendingOp {
  /** The outbox row id — the local sequence number (drain order). */
  id: number;
  /** The reconstructed, validated Op (payload decoded from the stored JSON). */
  op: Op;
}

/**
 * Append a validated op to the outbox and return its local seq (the
 * `outbox.id` / AUTOINCREMENT).
 *
 * The insert runs in a `db.transaction(...)` so that, if the caller is already
 * inside a transaction (e.g. a write routine bundling its DB mutation with this
 * enqueue), this insert joins that transaction via a SAVEPOINT and is discarded
 * when the caller rolls back — and persisted when it commits. When called with
 * no open transaction it simply commits its own row. `enqueueOp` never commits
 * a caller's transaction.
 *
 * @throws if `op` is not a well-formed Op (per {@link parseOp}).
 */
export function enqueueOp(db: Database.Database, op: Op): number {
  const normalized = parseOp(op);
  if (normalized === null) {
    throw new Error("enqueueOp: refusing to enqueue a malformed op");
  }

  const insert = db.prepare(
    `INSERT INTO outbox (gid, kind, origin, base_version, payload, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  );
  // A mutation is based on the version this machine has seen right now; a create (null) stays null.
  const baseVersion = normalized.base_version === null ? null : knownGidVersion(db, normalized.gid);
  // Wrap ONLY the insert: participates in a caller transaction via SAVEPOINT,
  // or commits standalone. Returning lastInsertRowid propagates the new seq.
  // The `payload` column stores the JSON of op.payload ONLY (spec 014 schema:
  // "canonical JSON of op.payload"); the other five schema fields live in their
  // own columns. A null payload is stored as the 4-char string "null".
  const insertTxn = db.transaction(() =>
    Number(insert.run(normalized.gid, normalized.kind, normalized.origin, baseVersion, JSON.stringify(normalized.payload), normalized.created_at).lastInsertRowid),
  );
  return insertTxn();
}

/**
 * Return all `pending` ops in local-seq (id) ascending order — the drain order
 * the sync loop ships to the server. Each entry carries its `id` and the full
 * reconstructed {@link Op} (payload decoded from the stored canonical JSON).
 */
export function pendingOps(db: Database.Database): PendingOp[] {
  const rows = db
    .prepare(
      `SELECT id, gid, kind, origin, base_version, payload, created_at
       FROM outbox WHERE status = 'pending' ORDER BY id ASC`,
    )
    .all() as OutboxRow[];

  return rows.map((r) => ({
    id: r.id,
    op: {
      gid: r.gid,
      kind: r.kind as Op["kind"],
      origin: r.origin,
      base_version: r.base_version,
      payload: JSON.parse(r.payload),
      created_at: r.created_at,
    },
  }));
}

/** Count of `pending` ops only (sent / acked / failed are not pending). */
export function pendingCount(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
    .get() as { n: number };
  return row.n;
}

/**
 * Move the given outbox ids from `pending`/`failed` to `sent` (first delivery
 * and retry after a backoff window). A no-op for unknown ids.
 */
export function markSent(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE outbox SET status = 'sent'
     WHERE id IN (${ph}) AND status IN ('pending', 'failed')`,
  ).run(...ids);
}

/**
 * Mark a single op `acked` and record the server-assigned global seq. The
 * attempt counter is left untouched. A no-op for unknown ids.
 */
export function markAcked(db: Database.Database, id: number, serverSeq: number): void {
  db.prepare(
    `UPDATE outbox SET status = 'acked', server_seq = ? WHERE id = ?`,
  ).run(serverSeq, id);
}

/**
 * Mark a single op `failed`, incrementing its attempt counter and recording the
 * backoff retry time and the failure reason. `nextAttemptAt` is an absolute
 * ms-since-epoch deadline owned by the caller (the Phase 4 sync loop computes
 * the exponential backoff). Repeated failures on the same op accumulate the
 * counter; a terminal `acked` row is never clobbered. A no-op for unknown ids.
 */
export function markFailed(
  db: Database.Database,
  id: number,
  error: string,
  nextAttemptAt: number,
): void {
  db.prepare(
    `UPDATE outbox
     SET status = 'failed',
         attempts = attempts + 1,
         next_attempt_at = ?,
         last_error = ?
     WHERE id = ? AND status != 'acked'`,
  ).run(nextAttemptAt, error, id);
}
