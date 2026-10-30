/**
 * Remote client + adaptive short-polling sync loop.
 *
 * The client half of the wire boundary. Everything here talks to a `kontexta-brain-host` over plain,
 * stateless HTTP, scoped to this machine's brain by its bearer token:
 *
 *   GET  {remote}/ops?since&limit&acked  poll remote ops since the cursor
 *   POST {remote}/ops                    ship the local outbox batch
 *
 * The connection (remote URL, token, brain share hash) lives in the local `settings` table and is managed
 * by brain.ts (`joinBrain`, `disconnectBrain`); the loop re-reads it every tick, so connect and disconnect
 * take effect without a restart, and an unconnected machine simply never syncs.
 *
 *   PUSH — `pushOutbox` drains due outbox rows (`pending`, plus `failed` whose
 *   backoff window elapsed) in local-seq order, marks them `sent`, POSTs the
 *   batch, then `acked` (recording the server seq) or `failed` (attempt counter
 *   + exponential backoff via {@link markFailed}). Two wire contracts:
 *     * `client_seq` = the outbox id, so a retried batch after a lost ACK is a
 *       server-side no-op (the `(origin, client_seq)` partial unique index) that
 *       returns the ORIGINAL seq — delivery is at-least-once, effect exactly-once.
 *     * `base_version` is captured when the op is enqueued (see versions.ts): the server
 *       version of the gid this machine has seen (own acks + pulled ops), plus
 *       same-batch predecessors. A true create (stored `null`) on a fresh gid
 *       stays `null` (the "no prior state" assertion).
 *     * Orphaned `sent` rows (the process died mid-POST) are re-queued to
 *       `pending` at the start of every push; double-delivery is safe because of
 *       the dedup above — this is what makes crash recovery lossless.
 *
 *   PULL — `pullRemoteOps` pages `GET /ops?since=<cursor>&limit=` until caught
 *   up, applies each row via {@link applyRemoteOp} (echo suppression + the
 *   cross-process sync lock live there), and advances `sync_cursor` to the
 *   highest seq fully applied. Own-origin ops are skipped, not re-applied.
 *   A malformed op fails CLOSED (the cursor never moves past it). An op that
 *   cannot be applied here is recorded in `sync_skipped_ops` and skipped
 *   (immediately when unappliable, after MAX_APPLY_ATTEMPTS ticks otherwise)
 *   so one bad op cannot block every later one. Server-flagged conflicts on
 *   file content fork a conflict copy (storage/conflicts.ts) instead of
 *   overwriting the local file.
 *
 *   LOOP — `startSyncLoop` is the adaptive short-poller (spec 1.6): a process
 *   singleton that ticks push-then-pull, then sleeps the ACTIVE cadence (15 s,
 *   default) while there is activity and the IDLE cadence (60 s) otherwise.
 *   Activity = the host-provided `isActivity` probe (e.g. recent web/agent
 *   activity) OR a non-empty pending outbox (work just landed locally). Any
 *   tick failure doubles the sleep from `backoffInitialMs` (1 s) up to
 *   `backoffMaxMs` (5 min); a healthy tick resets the counter. The loop never
 *   owns the DB connection or process lifecycle — it is started by the host
 *   (`kontexta brain` / apps) and stopped on shutdown.
 *
 * All functions take an explicit `db` handle (the caller owns the connection —
 * the storage module's convention) and accept an injectable `fetchImpl`, so
 * tests run against a fake HTTP server without sockets leaking into the real
 * network.
 */

import type { Database } from "better-sqlite3";
import { kindFamily, parseOp, type Op } from "./op.js";
import { markAcked, markFailed, markSent, pendingCount } from "./outbox.js";
import { applyRemoteOp } from "./apply.js";
import { fetchJson, describeError, DEFAULT_REQUEST_TIMEOUT_MS, type FetchJsonResult } from "./http.js";
import { bootstrapIfNeeded, bootstrapPending } from "./bootstrap.js";
import { decryptPayload, encryptPayload } from "./crypto.js";
import { readBrainConfig, readBrainKey, settingValue, normalizeBaseUrl, ACTIVE_POLL_INTERVAL_DEFAULT_MS, IDLE_POLL_INTERVAL_DEFAULT_MS } from "./brain.js";
export { normalizeBaseUrl, DEFAULT_REQUEST_TIMEOUT_MS, ACTIVE_POLL_INTERVAL_DEFAULT_MS, IDLE_POLL_INTERVAL_DEFAULT_MS };
import { UnappliableOpError } from "./errors.js";
import { ensureConflictsTable } from "./conflicts.js";
import { mergeOrFork } from "./journal-merge.js";
import { bumpPendingBases, clearLostPush, hasLostPush, knownGidVersions, markLostPush, recordGidVersion, versionKey } from "./versions.js";

// ---------------------------------------------------------------------------
// Tunables (spec 1.6)
// ---------------------------------------------------------------------------

/** First retry delay after a delivery failure: 1 s (spec 1.6 backoff). */
export const BACKOFF_INITIAL_MS = 1_000;
/** Backoff ceiling: 5 minutes (spec 1.6 "exponential backoff up to 5 minutes"). */
export const BACKOFF_MAX_MS = 300_000;
/**
 * Hard cap on a single POST /ops batch. Mirrors the server's `MAX_OPS_LIMIT`
 * (packages/brain-host/src/routes/ops.ts); a larger outbox drains over
 * successive ticks.
 */
export const MAX_BATCH_SIZE = 1000;
/** Apply failures (other than an explicitly unappliable op) are retried this many ticks, then the op is skipped and recorded. */
export const MAX_APPLY_ATTEMPTS = 5;
/** Floor for a sane poll interval; anything smaller is treated as malformed. */
const MIN_POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Outbox push
// ---------------------------------------------------------------------------

export interface PushOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

/** Outcome of one {@link pushOutbox} drain. */
export interface PushResult {
  /** Due ops that were selected and delivered. */
  attempted: number;
  /** Ops the server accepted (acked; includes idempotent `duplicate` retries). */
  delivered: number;
  /** Ops the server flagged `status: "conflict"` (spec 1.7) — delivered AND reported. */
  conflicts: Op[];
  /** Non-null when nothing could be delivered (network/HTTP/malformed response). */
  error: string | null;
}

/**
 * Exponential retry delay after `failuresSoFar` consecutive failures of an op
 * (or tick): `initial * 2^failuresSoFar`, capped at `max`.
 *
 *   failuresSoFar: 0   1   2    3     4     5     6      7      8     9+
 *   delay:         1s  2s  4s   8s   16s   32s   64s    128s   256s  5min
 *
 * (defaults: initial 1 s, max 5 min — spec 1.6 "exponential backoff up to 5 minutes")
 */
export function backoffDelay(
  failuresSoFar: number,
  initialMs: number = BACKOFF_INITIAL_MS,
  maxMs: number = BACKOFF_MAX_MS,
): number {
  const exp = Math.max(0, Math.min(Math.trunc(failuresSoFar), 9));
  return Math.min(initialMs * 2 ** exp, maxMs);
}

/**
 * Ship the due outbox ops to the server and reconcile their delivery state.
 *
 *   1. Re-queue orphaned `sent` rows (crash recovery — see module header).
 *   2. Select due rows: `pending`, plus `failed` whose `next_attempt_at`
 *      backoff deadline has elapsed, in local-seq (id) order, capped at
 *      {@link MAX_BATCH_SIZE}.
 *   3. Rewrite each op's `base_version` (spec 1.7 client protocol) and mark
 *      the batch `sent`.
 *   4. POST the batch. On success: `acked` per op with the server seq;
 *      conflict-flagged ops are reported in `conflicts` (still acked —
 *      delivery is terminal, the CONFLICT is a report, not a retry trigger).
 *      On any failure: the whole batch is `failed`, each op's attempt counter
 *      incremented, and the exponential backoff deadline recorded.
 *
 * Never throws for network/HTTP problems — those are returned in `error` so
 * the sync loop (and the CLI `endpoint push`) can react uniformly.
 */
export async function pushOutbox(db: Database, options: PushOptions = {}): Promise<PushResult> {
  const cfg = readBrainConfig(db);
  if (!cfg.connected) {
    return { attempted: 0, delivered: 0, conflicts: [], error: "not connected" };
  }
  if (bootstrapPending(db)) {
    return { attempted: 0, delivered: 0, conflicts: [], error: "brain bootstrap pending" };
  }
  const brainKey = readBrainKey(db);
  if (brainKey === null) {
    return { attempted: 0, delivered: 0, conflicts: [], error: "this machine has no brain key; reconnect with the share id" };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // Crash recovery: a `sent` row whose process died mid-POST is orphaned.
  // Re-queue it; the server's (origin, client_seq) dedup makes a
  // double-delivery a no-op, so this is safe even if another process on this
  // machine is still mid-POST (both end up acked with the same server seq).
  db.prepare(`UPDATE outbox SET status = 'pending' WHERE status = 'sent'`).run();

  const now = Date.now();
  const due = db
    .prepare(
      `SELECT id, attempts FROM outbox
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(now, MAX_BATCH_SIZE) as Array<{ id: number; attempts: number }>;
  if (due.length === 0) {
    return { attempted: 0, delivered: 0, conflicts: [], error: null };
  }

  const ids = due.map((r) => r.id);
  const attemptsById = new Map(due.map((r) => [r.id, r.attempts]));
  const ph = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, gid, kind, origin, base_version, payload, created_at
       FROM outbox WHERE id IN (${ph}) ORDER BY id ASC`,
    )
    .all(...ids) as Array<{
    id: number;
    gid: string;
    kind: string;
    origin: string;
    base_version: number | null;
    payload: string;
    created_at: number;
  }>;

  // The stored base_version was captured when the edit was enqueued; the server applies a batch in order,
  // so each op is also based on the earlier ops for its gid in this batch. A create (null) with no predecessor stays null.
  const seenInBatch = new Map<string, number>();
  const wire = rows.map((r) => {
    const key = versionKey(r.gid, kindFamily(r.kind as Op["kind"]));
    const predecessors = seenInBatch.get(key) ?? 0;
    seenInBatch.set(key, predecessors + 1);
    const baseVersion = r.base_version === null && predecessors === 0 ? null : (r.base_version ?? 0) + predecessors;
    return {
      id: r.id,
      op: {
        gid: r.gid,
        kind: r.kind as Op["kind"],
        origin: r.origin,
        base_version: r.base_version,
        payload: JSON.parse(r.payload),
        created_at: r.created_at,
      } as Op,
      wireBase: baseVersion,
    };
  });

  markSent(db, ids);

  const body = JSON.stringify(
    wire.map((w) => ({
      gid: w.op.gid,
      kind: w.op.kind,
      origin: w.op.origin,
      base_version: w.wireBase,
      payload: encryptPayload(brainKey, w.op.payload, w.op.gid, w.op.kind, w.op.origin),
      created_at: w.op.created_at,
      client_seq: w.id,
    })),
  );

  let res: FetchJsonResult;
  try {
    res = await fetchJson(fetchImpl, `${cfg.remoteUrl}/ops`, options.signal, {
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      body,
      timeoutMs: options.requestTimeoutMs,
    });
  } catch (err) {
    const msg = describeError(err);
    failBatch(db, due, `request failed: ${msg}`);
    return { attempted: ids.length, delivered: 0, conflicts: [], error: msg };
  }

  if (res.status !== 200) {
    const msg = `HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`;
    failBatch(db, due, msg);
    return { attempted: ids.length, delivered: 0, conflicts: [], error: msg };
  }

  const results = (res.body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    const msg = "malformed POST /ops response (missing results[])";
    failBatch(db, due, msg);
    return { attempted: ids.length, delivered: 0, conflicts: [], error: msg };
  }

  const byClientSeq = new Map<number, { seq: number; status: string; version: number | null }>();
  for (const raw of results) {
    const r = raw as { client_seq?: unknown; seq?: unknown; status?: unknown; version?: unknown };
    if (
      typeof r.client_seq === "number" &&
      typeof r.seq === "number" &&
      typeof r.status === "string"
    ) {
      byClientSeq.set(r.client_seq, {
        seq: r.seq,
        status: r.status,
        version: typeof r.version === "number" && Number.isInteger(r.version) ? r.version : null,
      });
    }
  }

  const conflicts: Op[] = [];
  let delivered = 0;
  const knownByGid = knownGidVersions(db, wire.map((w) => w.op.gid));
  for (const w of wire) {
    const r = byClientSeq.get(w.id);
    if (r === undefined) {
      // The server acked the batch but not this op — do not ack it; retry it
      // (its client_seq dedups against whatever the server stored).
      markFailed(
        db,
        w.id,
        "server response missing a result for client_seq",
        Date.now() + backoffDelay(attemptsById.get(w.id) ?? 0),
      );
      continue;
    }
    if (r.status === "conflict") {
      // Delivered AND reported: the op is in the authoritative log (acked is
      // terminal — retrying it would only re-dedup), and the conflict is
      // surfaced for the user / the Phase 5 Conflict Manager.
      conflicts.push(w.op);
      if (w.op.kind === "file.create" || w.op.kind === "file.update") markLostPush(db, w.op.gid);
    }
    markAcked(db, w.id, r.seq);
    const family = kindFamily(w.op.kind);
    recordGidVersion(db, w.op.gid, family, r.version ?? (knownByGid.get(versionKey(w.op.gid, family)) ?? 0) + 1);
    // A lost op did not raise the accepted version, so later pending ops keep their base (and lose too).
    if (r.status !== "conflict") bumpPendingBases(db, w.op.gid, family, w.id);
    delivered++;
  }

  return { attempted: ids.length, delivered, conflicts, error: null };
}

/** Mark every op of a failed batch `failed` with its own backoff deadline. */
function failBatch(
  db: Database,
  due: Array<{ id: number; attempts: number }>,
  error: string,
): void {
  const now = Date.now();
  for (const r of due) {
    markFailed(db, r.id, error, now + backoffDelay(r.attempts));
  }
}

// ---------------------------------------------------------------------------
// Remote-op pull
// ---------------------------------------------------------------------------

export interface PullOptions extends PushOptions {
  /** Page size for GET /ops (1..1000; default the server's max, 1000). */
  pageLimit?: number;
}

/** Outcome of one {@link pullRemoteOps} catch-up. */
export interface PullResult {
  /** Ops served by the server (including own-origin skips). */
  polled: number;
  /** Remote ops applied to the local store. */
  applied: number;
  /** Remote ops recorded in `sync_skipped_ops` instead of applied. */
  skipped: number;
  /** Server-flagged conflicts among the remote ops (see module header). */
  conflicts: Op[];
  /** The cursor position after this pull (the highest seq fully applied). */
  cursor: number;
  /** Non-null on a network/HTTP/malformed-apply failure (fail closed). */
  error: string | null;
}

/** The client's high-water mark into the server's seq stream (`sync_cursor`). */
export function getSyncCursor(db: Database): number {
  const row = db
    .prepare("SELECT last_seq FROM sync_cursor WHERE id = 1")
    .get() as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

/**
 * Advance the polling cursor. Monotonic by construction (`MAX`): a lower seq
 * can never regress it, so a torn or replayed response is harmless.
 */
export function advanceSyncCursor(db: Database, seq: number): void {
  db.prepare(
    `UPDATE sync_cursor SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE id = 1`,
  ).run(seq, Date.now());
}

/** True when a remote content op must be parked as a conflict copy instead of overwriting the local file. */
export function shouldForkInsteadOfApply(db: Database, op: Op, status: unknown): boolean {
  if (op.kind !== "file.create" && op.kind !== "file.update") return false;
  const local = db.prepare("SELECT content_hash FROM files WHERE gid = ?").get(op.gid) as { content_hash: string | null } | undefined;
  if (local === undefined) return false;
  // Two machines that ended up with the same content have nothing to resolve.
  const remoteHash = (op.payload as { content_hash?: unknown }).content_hash;
  if (typeof remoteHash === "string" && remoteHash === local.content_hash) return false;
  if (status === "conflict" || hasLostPush(db, op.gid)) return true;
  const unsent = db
    .prepare(
      `SELECT 1 FROM outbox WHERE gid = ? AND kind IN ('file.create', 'file.update')
       AND status IN ('pending', 'sent', 'failed') LIMIT 1`,
    )
    .get(op.gid);
  if (unsent !== undefined) return true;
  ensureConflictsTable(db);
  return db.prepare("SELECT 1 FROM conflicts WHERE gid = ? AND status = 'unresolved'").get(op.gid) !== undefined;
}

function clearApplyFailure(db: Database, seq: number): void {
  db.prepare("DELETE FROM sync_skipped_ops WHERE seq = ? AND skipped = 0").run(seq);
}

/** Record an apply failure; true when the op is now skipped (unappliable, or out of retries). */
function recordApplyFailure(db: Database, seq: number, op: Op, err: unknown): boolean {
  const unappliable = err instanceof UnappliableOpError;
  const prior = db.prepare("SELECT attempts FROM sync_skipped_ops WHERE seq = ?").get(seq) as
    | { attempts: number }
    | undefined;
  const attempts = (prior?.attempts ?? 0) + 1;
  const skip = unappliable || attempts >= MAX_APPLY_ATTEMPTS;
  db.prepare(
    `INSERT INTO sync_skipped_ops (seq, gid, kind, origin, error, attempts, skipped, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(seq) DO UPDATE SET error = excluded.error, attempts = excluded.attempts, skipped = excluded.skipped`,
  ).run(seq, op.gid, op.kind, op.origin, describeError(err), attempts, skip ? 1 : 0, Date.now());
  return skip;
}

/**
 * Poll the server for ops since the cursor, apply each one, and advance the
 * cursor — paging until the stream is caught up.
 *
 *   * Own-origin ops are SKIPPED (the server serves the full log, including
 *     this machine's own ops; re-applying them would be at best a no-op).
 *   * Every other op goes through {@link applyRemoteOp} (validation, the
 *     cross-process sync lock, echo suppression all live there).
 *   * Fail closed: if an op is malformed or cannot be applied, the pull stops
 *     and the cursor is NOT advanced past that op — the next tick retries the
 *     same seq. History is never silently skipped.
 *   * The cursor advances only after a whole page applied cleanly.
 */
export async function pullRemoteOps(db: Database, options: PullOptions = {}): Promise<PullResult> {
  const cfg = readBrainConfig(db);
  if (!cfg.connected) {
    return {
      polled: 0,
      applied: 0,
      skipped: 0,
      conflicts: [],
      cursor: getSyncCursor(db),
      error: "not connected",
    };
  }
  if (bootstrapPending(db)) {
    return { polled: 0, applied: 0, skipped: 0, conflicts: [], cursor: getSyncCursor(db), error: "brain bootstrap pending" };
  }
  const brainKey = readBrainKey(db);
  if (brainKey === null) {
    return { polled: 0, applied: 0, skipped: 0, conflicts: [], cursor: getSyncCursor(db), error: "this machine has no brain key; reconnect with the share id" };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const machineId = settingValue(db, "machine_id") ?? "";
  const pageLimit = Math.min(
    Math.max(Math.trunc(options.pageLimit ?? MAX_BATCH_SIZE), 1),
    MAX_BATCH_SIZE,
  );

  let cursor = getSyncCursor(db);
  let polled = 0;
  let applied = 0;
  let skipped = 0;
  const conflicts: Op[] = [];

  for (;;) {
    let res: FetchJsonResult;
    try {
      res = await fetchJson(
        fetchImpl,
        `${cfg.remoteUrl}/ops?since=${cursor}&limit=${pageLimit}&acked=${cursor}`,
        options.signal,
        {
          headers: { authorization: `Bearer ${cfg.token}` },
          timeoutMs: options.requestTimeoutMs,
        },
      );
    } catch (err) {
      return { polled, applied, skipped, conflicts, cursor, error: describeError(err) };
    }
    if (res.status !== 200) {
      return {
        polled,
        applied,
        skipped,
        conflicts,
        cursor,
        error: `HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
      };
    }
    const body = res.body as { ops?: unknown; next?: unknown } | null;
    if (!body || !Array.isArray(body.ops)) {
      return { polled, applied, skipped, conflicts, cursor, error: "malformed GET /ops response" };
    }
    const rows = body.ops as Array<Record<string, unknown>>;

    // Highest seq handled so far in this page; kept on a mid-page failure so handled ops are not replayed.
    let done = cursor;
    const keepProgress = (): void => {
      if (done > cursor) {
        advanceSyncCursor(db, done);
        cursor = done;
      }
    };
    for (const row of rows) {
      polled++;
      const rowSeq = typeof row.seq === "number" ? row.seq : null;
      const rowGid = typeof row.gid === "string" ? row.gid : null;
      const rowVersion = typeof row.gid_version === "number" ? row.gid_version : null;
      // Own-origin: this is OUR op echoed back from the authoritative log.
      // The local state IS the source for it, so record its version and skip it.
      if (typeof row.origin === "string" && row.origin === machineId) {
        if (rowGid !== null && rowVersion !== null && typeof row.kind === "string") {
          recordGidVersion(db, rowGid, kindFamily(row.kind as Op["kind"]), rowVersion);
        }
        if (rowSeq !== null) done = rowSeq;
        continue;
      }
      let plainPayload: unknown;
      try {
        plainPayload = decryptPayload(brainKey, row.payload, String(row.gid), String(row.kind), String(row.origin));
      } catch (err) {
        // Fail closed: ciphertext that does not authenticate was altered or is not from this brain.
        keepProgress();
        return {
          polled,
          applied,
          skipped,
          conflicts,
          cursor,
          error: `refusing to advance past an op that failed to decrypt (seq ${String(row.seq)}): ${describeError(err)}`,
        };
      }
      const op = parseOp({
        gid: row.gid,
        kind: row.kind,
        origin: row.origin,
        base_version: row.base_version,
        payload: plainPayload,
        created_at: row.created_at,
      });
      if (op === null) {
        // Fail closed: never advance the cursor past an op we cannot
        // understand (a client/server version skew must be an incident, not a
        // silent skip of history).
        keepProgress();
        return {
          polled,
          applied,
          skipped,
          conflicts,
          cursor,
          error: `refusing to advance past malformed op (seq ${String(row.seq)})`,
        };
      }
      const seq = rowSeq ?? 0;
      try {
        if (row.status === "conflict") conflicts.push(op);
        if (row.status === "conflict" && op.kind === "file.delete") {
          // Lost optimistic concurrency: never delete a file another machine just edited.
        } else if (shouldForkInsteadOfApply(db, op, row.status)) {
          mergeOrFork(db, op, seq);
          clearLostPush(db, op.gid);
        } else {
          await applyRemoteOp(op, { db });
          // The accepted remote state is now ours (or identical), so an old lost push no longer applies.
          if (op.kind === "file.create" || op.kind === "file.update") clearLostPush(db, op.gid);
        }
        applied++;
        clearApplyFailure(db, seq);
        if (rowVersion !== null) recordGidVersion(db, op.gid, kindFamily(op.kind), rowVersion);
        if (rowSeq !== null) done = rowSeq;
      } catch (err) {
        if (recordApplyFailure(db, seq, op, err)) {
          skipped++;
          if (rowVersion !== null) recordGidVersion(db, op.gid, kindFamily(op.kind), rowVersion);
          if (rowSeq !== null) done = rowSeq;
          continue;
        }
        keepProgress();
        return {
          polled,
          applied,
          skipped,
          conflicts,
          cursor,
          error: `failed to apply seq ${String(row.seq)}: ${describeError(err)}`,
        };
      }
    }

    const lastSeq =
      rows.length > 0 && typeof rows[rows.length - 1].seq === "number"
        ? (rows[rows.length - 1].seq as number)
        : cursor;
    const next =
      typeof body.next === "number" && Number.isInteger(body.next) && body.next >= 0
        ? body.next
        : lastSeq;
    const advanced = next > cursor;
    if (advanced) {
      advanceSyncCursor(db, next);
    }
    const caughtUp = rows.length < pageLimit || !advanced;
    cursor = Math.max(cursor, next);
    if (caughtUp) break;
  }

  return { polled, applied, skipped, conflicts, cursor, error: null };
}

// ---------------------------------------------------------------------------
// The adaptive short-polling sync loop
// ---------------------------------------------------------------------------

export interface SyncLoopOptions {
  /** Override the active cadence (otherwise read from settings every tick). */
  activePollIntervalMs?: number;
  /** Override the idle cadence (otherwise read from settings every tick). */
  idlePollIntervalMs?: number;
  /** Backoff base (default 1 s). */
  backoffInitialMs?: number;
  /** Backoff ceiling (default 5 min). */
  backoffMaxMs?: number;
  fetchImpl?: typeof fetch;
  /** Aborting this stops the loop (and in-flight requests). */
  signal?: AbortSignal;
  /**
   * Activity probe for the active/idle cadence (spec 1.6). The host wires this
   * to real activity (recent web/agent requests). When absent, a non-empty
   * pending outbox counts as activity.
   */
  isActivity?: () => boolean;
  /** Page size for the pull (1..1000). */
  pageLimit?: number;
  /**
   * Schedule the first tick immediately (default true). Hosts that drive
   * {@link SyncLoopHandle.tick} manually pass `false`.
   */
  autoStart?: boolean;
}

/** The outcome of one sync tick (push, then pull, then the next sleep). */
export interface SyncTickResult {
  /**
   * `ok` = a healthy round-trip; `backoff` = a failure (sleep = the backoff
   * delay); `disconnected` = no endpoint configured (dormant; re-checks on the
   * idle cadence so a mid-run `joinBrain` is picked up).
   */
  phase: "ok" | "backoff" | "disconnected";
  push: PushResult | null;
  pull: PullResult | null;
  /** How long the loop sleeps before the next tick. */
  nextDelayMs: number;
}

/** A live view of the loop's runtime state. */
export interface SyncLoopState {
  running: boolean;
  connected: boolean;
  /** When the last HEALTHY tick completed (ms since epoch), or null. */
  lastSyncAt: number | null;
  /** The last tick's error, or null when healthy. */
  lastError: string | null;
  /** The current backoff sleep (0 when healthy). */
  backoffMs: number;
  /** Consecutive failed ticks (resets on a healthy tick). */
  consecutiveFailures: number;
  /** The current polling cursor (highest fully-applied server seq). */
  cursor: number;
  /** Outbox ops still `pending` delivery. */
  pending: number;
}

export interface SyncLoopHandle {
  /** Stop the loop (clears the pending timer; an in-flight tick finishes but does not reschedule). */
  stop(): void;
  /** Run one push-then-pull round-trip NOW (also what the timer fires). */
  tick(): Promise<SyncTickResult>;
  /** A snapshot of the loop's runtime state. */
  state(): SyncLoopState;
}

/** The process's single sync loop (null when none is running). */
let activeLoop: SyncLoopHandle | null = null;

/**
 * Start (or return the running) process-wide sync loop.
 *
 * The loop is a singleton because there must be exactly one poller per
 * machine: two loops would double-push (safe, but wasteful) and race the
 * cursor. The host starts it at boot (after the DB is open) and calls
 * {@link stopSyncLoop} on shutdown.
 *
 * Each tick: re-read the endpoint config (connect/disconnect take effect live)
 * → push due outbox ops → pull + apply remote ops → sleep. A healthy tick
 * sleeps the ACTIVE cadence while there is activity (the `isActivity` probe,
 * or a pending outbox) and the IDLE cadence otherwise; a failed tick sleeps
 * the exponential backoff (1 s → 5 min, doubling) and resets on recovery.
 *
 * The sleep timer is `unref()`'d: it never keeps the process alive on its own
 * (CLI one-shot commands, test runners). The host keeps the process alive
 * explicitly for as long as it wants the loop running.
 */
export function startSyncLoop(
  db: Database,
  options: SyncLoopOptions = {},
): SyncLoopHandle {
  if (activeLoop) return activeLoop;

  const initial = options.backoffInitialMs ?? BACKOFF_INITIAL_MS;
  const max = options.backoffMaxMs ?? BACKOFF_MAX_MS;
  const st = {
    consecutiveFailures: 0,
    backoffMs: 0,
    lastSyncAt: null as number | null,
    lastError: null as string | null,
  };
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const tick = async (): Promise<SyncTickResult> => {
    // The config is re-read EVERY tick (never cached): a mid-run
    // joinBrain / disjoinBrain / poll-interval change takes effect
    // on the very next tick, with no loop restart.
    const cfg = readBrainConfig(db);
    const activeMs = options.activePollIntervalMs ?? cfg.activePollIntervalMs;
    const idleMs = options.idlePollIntervalMs ?? cfg.idlePollIntervalMs;

    if (!cfg.connected) {
      // Dormant: no requests at all. Re-check on the idle cadence so a
      // mid-run `kontexta brain connect` is picked up without a restart.
      st.consecutiveFailures = 0;
      st.backoffMs = 0;
      return { phase: "disconnected", push: null, pull: null, nextDelayMs: idleMs };
    }

    let push: PushResult | null = null;
    let pull: PullResult | null = null;
    let error: string | null = null;
    try {
      await bootstrapIfNeeded(db, { fetchImpl: options.fetchImpl, signal: options.signal });
      push = await pushOutbox(db, {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      });
      if (push.error && push.error !== "not connected") {
        error = push.error;
      }
      if (error === null) {
        pull = await pullRemoteOps(db, {
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          pageLimit: options.pageLimit,
        });
        if (pull.error && pull.error !== "not connected") {
          error = pull.error;
        }
      }
    } catch (err) {
      // pushOutbox/pullRemoteOps report their own failures; this is a
      // belt-and-braces guard so the loop can never die from a tick.
      error = describeError(err);
    }

    if (error !== null) {
      st.consecutiveFailures += 1;
      st.backoffMs = backoffDelay(st.consecutiveFailures - 1, initial, max);
      st.lastError = error;
      return { phase: "backoff", push, pull, nextDelayMs: st.backoffMs };
    }

    st.consecutiveFailures = 0;
    st.backoffMs = 0;
    st.lastError = null;
    st.lastSyncAt = Date.now();
    // Spec 1.6 cadence: active while there is activity, idle otherwise.
    const active = (options.isActivity?.() ?? false) || pendingCount(db) > 0;
    return { phase: "ok", push, pull, nextDelayMs: active ? activeMs : idleMs };
  };

  const schedule = (delayMs: number): void => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runTick();
    }, Math.max(0, delayMs));
    // The timer must never keep the process alive on its own.
    timer.unref?.();
  };

  const runTick = async (): Promise<void> => {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      const res = await tick();
      schedule(res.nextDelayMs);
    } catch {
      // tick() never throws (it catches internally); if it ever does, back off
      // rather than kill the loop.
      schedule(initial);
    } finally {
      inFlight = false;
    }
  };

  const onAbort = (): void => handle.stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const handle: SyncLoopHandle = {
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      options.signal?.removeEventListener("abort", onAbort);
      if (activeLoop === handle) activeLoop = null;
    },
    tick,
    state() {
      const cfg = readBrainConfig(db);
      return {
        running,
        connected: cfg.connected,
        lastSyncAt: st.lastSyncAt,
        lastError: st.lastError,
        backoffMs: st.backoffMs,
        consecutiveFailures: st.consecutiveFailures,
        cursor: getSyncCursor(db),
        pending: pendingCount(db),
      };
    },
  };

  activeLoop = handle;
  if (options.autoStart !== false) {
    // First tick immediately: a freshly started loop should not wait a full
    // cadence for work that is already due.
    timer = setTimeout(() => {
      timer = null;
      void runTick();
    }, 0);
    timer.unref?.();
  }

  return handle;
}

/** Stop the process-wide sync loop (no-op when none is running). */
export function stopSyncLoop(): void {
  if (activeLoop) {
    activeLoop.stop();
  }
}

/** The currently running sync loop, or null. */
export function getSyncLoop(): SyncLoopHandle | null {
  return activeLoop;
}

/** Alias for startSyncLoop matching the milestone spec name. */
export const syncLoop = startSyncLoop;
