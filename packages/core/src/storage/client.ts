/**
 * Endpoint client + adaptive short-polling sync loop — Phase 4 (storage/04-server).
 *
 * The client half of the wire boundary. Everything here talks to a
 * `kontexta-storage-server` deployment (spec 1.6) over plain, stateless HTTP —
 * no persistent connections (the serverless billing rationale, spec 1.6):
 *
 *   GET  {endpoint}/health          connect-time probe (unauthenticated)
 *   GET  {endpoint}/ops?since&limit poll remote ops since the cursor (Bearer)
 *   POST {endpoint}/ops             ship the local outbox batch (Bearer)
 *
 * The three concerns and their invariants:
 *
 *   CONFIG — the connection lives in the local `settings` table (migration 015):
 *   `endpoint_url` + `endpoint_token` (both non-empty = connected; the empty
 *   seed means "not connected" and the loop stays dormant) plus the two poll
 *   cadences. `connectEndpoint` VERIFIES the server before persisting (health +
 *   a token probe), so a typo'd URL or token fails loudly at connect time.
 *   `disconnectEndpoint` deletes the two credentials (the loop notices on its
 *   next tick — the config is re-read every tick, never cached).
 *
 *   PUSH — `pushOutbox` drains due outbox rows (`pending`, plus `failed` whose
 *   backoff window elapsed) in local-seq order, marks them `sent`, POSTs the
 *   batch, then `acked` (recording the server seq) or `failed` (attempt counter
 *   + exponential backoff via {@link markFailed}). Two wire contracts:
 *     * `client_seq` = the outbox id, so a retried batch after a lost ACK is a
 *       server-side no-op (the `(origin, client_seq)` partial unique index) that
 *       returns the ORIGINAL seq — delivery is at-least-once, effect exactly-once.
 *     * `base_version` is REWRITTEN at send time from the local per-gid
 *       high-water mark (count of acked ops for the gid, + same-batch
 *       predecessors) — spec 1.7's client protocol, documented in the server's
 *       routes/ops.ts. The Phase 3 write sites hardcode `0` as a "mutation"
 *       marker; the value the server actually compares is "the last version I
 *       acked for this gid". A true create (stored `null`) on a fresh gid stays
 *       `null` (the "no prior state" assertion).
 *     * Orphaned `sent` rows (the process died mid-POST) are re-queued to
 *       `pending` at the start of every push; double-delivery is safe because of
 *       the dedup above — this is what makes crash recovery lossless.
 *
 *   PULL — `pullRemoteOps` pages `GET /ops?since=<cursor>&limit=` until caught
 *   up, applies each row via {@link applyRemoteOp} (echo suppression + the
 *   cross-process sync lock live there), and advances `sync_cursor` to the
 *   highest seq fully applied. Own-origin ops (the server echoes our own log
 *   back) are skipped, not re-applied. Failure is CLOSED: a malformed or
 *   unappliable op stops the pull WITHOUT advancing the cursor past it, so the
 *   next tick retries the same seq rather than silently skipping history.
 *   Ops the server flagged `status: "conflict"` (spec 1.7) are still applied —
 *   the server log is the authoritative record — and surfaced in
 *   {@link PullResult.conflicts} / the loop state; the interactive fork +
 *   4-way resolution (keep-server / keep-mine / keep-both / merged) is the
 *   Phase 5 Conflict Manager's job (storage/conflicts.ts).
 *
 *   LOOP — `startSyncLoop` is the adaptive short-poller (spec 1.6): a process
 *   singleton that ticks push-then-pull, then sleeps the ACTIVE cadence (15 s,
 *   default) while there is activity and the IDLE cadence (60 s) otherwise.
 *   Activity = the host-provided `isActivity` probe (e.g. recent web/agent
 *   activity) OR a non-empty pending outbox (work just landed locally). Any
 *   tick failure doubles the sleep from `backoffInitialMs` (1 s) up to
 *   `backoffMaxMs` (5 min); a healthy tick resets the counter. The loop never
 *   owns the DB connection or process lifecycle — it is started by the host
 *   (`kontexta endpoint` / apps) and stopped on shutdown.
 *
 * All functions take an explicit `db` handle (the caller owns the connection —
 * the storage module's convention) and accept an injectable `fetchImpl`, so
 * tests run against a fake HTTP server without sockets leaking into the real
 * network.
 */

import type { Database } from "better-sqlite3";
import { parseOp, type Op } from "./op.js";
import { markAcked, markFailed, markSent, pendingCount } from "./outbox.js";
import { applyRemoteOp } from "./apply.js";

// ---------------------------------------------------------------------------
// Tunables (spec 1.6)
// ---------------------------------------------------------------------------

/** Active short-poll cadence: 15 s while the machine is active (spec 1.6). */
export const ACTIVE_POLL_INTERVAL_DEFAULT_MS = 15_000;
/** Idle short-poll cadence: 60 s when quiet (spec 1.6). */
export const IDLE_POLL_INTERVAL_DEFAULT_MS = 60_000;
/** First retry delay after a delivery failure: 1 s (spec 1.6 backoff). */
export const BACKOFF_INITIAL_MS = 1_000;
/** Backoff ceiling: 5 minutes (spec 1.6 "exponential backoff up to 5 minutes"). */
export const BACKOFF_MAX_MS = 300_000;
/**
 * Hard cap on a single POST /ops batch. Mirrors the server's `MAX_OPS_LIMIT`
 * (packages/storage-server/src/routes/ops.ts); a larger outbox drains over
 * successive ticks.
 */
export const MAX_BATCH_SIZE = 1000;
/** Floor for a sane poll interval; anything smaller is treated as malformed. */
const MIN_POLL_INTERVAL_MS = 1_000;
/** Default per-request timeout (short polls are cheap; a hung socket is a fault). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Endpoint configuration (migration 015 settings)
// ---------------------------------------------------------------------------

/** The machine's storage-endpoint configuration, read from `settings`. */
export interface EndpointConfig {
  /** True iff BOTH `endpoint_url` and `endpoint_token` are non-empty. */
  connected: boolean;
  /** The server base URL (normalized, no trailing slash). `""` = not set. */
  url: string;
  /** The machine's one-time sync token. `""` = not set. */
  token: string;
  /** Active-poll cadence in ms (sanitized; defaults per spec 1.6). */
  activePollIntervalMs: number;
  /** Idle-poll cadence in ms (sanitized; defaults per spec 1.6). */
  idlePollIntervalMs: number;
}

function settingValue(db: Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/** Upsert a setting (same shape as metadata/settings.ts `setSetting`). */
function settingUpsert(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

function settingDelete(db: Database, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/**
 * Parse a persisted poll interval. Malformed values (non-integer, below the
 * 1 s floor, empty) fall back to `fallback` rather than throwing — a corrupt
 * setting must never wedge the sync loop.
 */
function parseInterval(raw: string | null, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_POLL_INTERVAL_MS ? n : fallback;
}

/**
 * Normalize a user-supplied endpoint URL: trim, require an explicit http(s)
 * scheme, strip trailing slashes. Anything else throws — `connectEndpoint`
 * refuses to persist a URL it cannot talk to.
 */
export function normalizeBaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("normalizeBaseUrl: URL must be a non-empty string");
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`normalizeBaseUrl: not a valid URL: "${raw}"`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `normalizeBaseUrl: unsupported protocol "${u.protocol}" (http/https only)`,
    );
  }
  return u.toString().replace(/\/+$/, "");
}

/**
 * Read the endpoint configuration from `settings` (migration 015).
 * `connected` is false whenever either credential is missing/empty — a
 * machine that never ran `kontexta endpoint connect` simply does not sync.
 */
export function readEndpointConfig(db: Database): EndpointConfig {
  const url = settingValue(db, "endpoint_url") ?? "";
  const token = settingValue(db, "endpoint_token") ?? "";
  return {
    connected: url.length > 0 && token.length > 0,
    url,
    token,
    activePollIntervalMs: parseInterval(
      settingValue(db, "poll_active_interval_ms"),
      ACTIVE_POLL_INTERVAL_DEFAULT_MS,
    ),
    idlePollIntervalMs: parseInterval(
      settingValue(db, "poll_idle_interval_ms"),
      IDLE_POLL_INTERVAL_DEFAULT_MS,
    ),
  };
}

export interface ConnectEndpointOptions {
  /** Injectable fetch (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort the verification probes. */
  signal?: AbortSignal;
  /** Per-request timeout in ms (default {@link DEFAULT_REQUEST_TIMEOUT_MS}). */
  requestTimeoutMs?: number;
}

/**
 * Verify a storage endpoint and persist the connection.
 *
 * Sequence (all-or-nothing — nothing is persisted unless BOTH probes pass):
 *   1. `GET {url}/health` must answer 200 (and, if it identifies itself, must
 *      be a `kontexta-storage-server` — a 200 from some other service is a
 *      misconfiguration, not a success).
 *   2. `GET {url}/ops?since=0&limit=1` with `Bearer <token>` must NOT answer
 *      401/403 — the token is valid, so the machine is registered.
 *
 * Only then are `endpoint_url` (normalized) and `endpoint_token` upserted into
 * `settings`. Re-connecting to a different endpoint overwrites the previous
 * credentials; the running sync loop picks the change up on its next tick.
 *
 * @throws if the URL is not http(s), the token is empty, the server is
 *   unreachable, the health check fails, or the server rejects the token.
 */
export async function connectEndpoint(
  db: Database,
  endpointUrl: string,
  endpointToken: string,
  options: ConnectEndpointOptions = {},
): Promise<void> {
  const url = normalizeBaseUrl(endpointUrl);
  const token = typeof endpointToken === "string" ? endpointToken.trim() : "";
  if (token === "") {
    throw new Error("connectEndpoint: endpoint token must be a non-empty string");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const health = await fetchJson(fetchImpl, `${url}/health`, options.signal, {
    timeoutMs: options.requestTimeoutMs,
  });
  if (health.status !== 200) {
    throw new Error(`connectEndpoint: health check failed (HTTP ${health.status})`);
  }
  const service = (health.body as { service?: unknown } | null)?.service;
  if (typeof service === "string" && service !== "kontexta-storage-server") {
    throw new Error(`connectEndpoint: unexpected service at ${url} ("${service}")`);
  }

  const probe = await fetchJson(
    fetchImpl,
    `${url}/ops?since=0&limit=1`,
    options.signal,
    {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: options.requestTimeoutMs,
    },
  );
  if (probe.status === 401 || probe.status === 403) {
    throw new Error(
      "connectEndpoint: the server rejected the token (HTTP 401) — is this machine registered (POST /clients)?",
    );
  }
  if (probe.status !== 200) {
    throw new Error(`connectEndpoint: token probe failed (HTTP ${probe.status})`);
  }

  settingUpsert(db, "endpoint_url", url);
  settingUpsert(db, "endpoint_token", token);
}

/**
 * Clear the endpoint credentials (the `kontexta endpoint disconnect` action).
 * The poll cadences are left alone. A running sync loop notices on its next
 * tick and goes dormant (no requests are sent while disconnected).
 */
export function disconnectEndpoint(db: Database): void {
  settingDelete(db, "endpoint_url");
  settingDelete(db, "endpoint_token");
}

// ---------------------------------------------------------------------------
// HTTP helper (shared by connect / push / pull)
// ---------------------------------------------------------------------------

/** A decoded HTTP response (non-2xx bodies are kept as text for diagnostics). */
interface FetchJsonResult {
  status: number;
  /** Parsed JSON body (null when the body was not valid JSON). */
  body: unknown;
  /** Raw body text (for error diagnostics). */
  text: string;
}

/** One fetch with a timeout and JSON decode; network errors THROW. */
async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
  init: {
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<FetchJsonResult> {
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(new Error("request timed out")), timeoutMs);
  // Forward an external abort signal into this request.
  const onExternalAbort = (): void => ctrl.abort(signal?.reason);
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method: init.body === undefined ? "GET" : "POST",
      headers: init.headers,
      body: init.body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** A short, single-line description of an unknown thrown value. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError" || /timed out|aborted/i.test(err.message)
      ? `request aborted or timed out (${err.message})`
      : err.message;
  }
  return String(err);
}

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
  const cfg = readEndpointConfig(db);
  if (!cfg.connected) {
    return { attempted: 0, delivered: 0, conflicts: [], error: "not connected" };
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

  // base_version rewrite (spec 1.7 client protocol): the local high-water mark
  // for the gid = the number of its ops already acked, plus any same-batch
  // predecessors (shipped in local-seq order; the server applies them in that
  // order, so each op is based on everything before it). A stored `null`
  // (a true create) on a gid at version 0 stays `null` — the "no prior state"
  // assertion the server expects for a first-time create.
  const gidVersions = new Map<string, number>(
    (
      db
        .prepare(
          `SELECT gid, COUNT(*) AS n FROM outbox WHERE status = 'acked' GROUP BY gid`,
        )
        .all() as Array<{ gid: string; n: number }>
    ).map((r) => [r.gid, r.n]),
  );
  const seenInBatch = new Map<string, number>();
  const wire = rows.map((r) => {
    const predecessors = seenInBatch.get(r.gid) ?? 0;
    seenInBatch.set(r.gid, predecessors + 1);
    const base = (gidVersions.get(r.gid) ?? 0) + predecessors;
    const baseVersion = base === 0 && r.base_version === null ? null : base;
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
      payload: w.op.payload,
      created_at: w.op.created_at,
      client_seq: w.id,
    })),
  );

  let res: FetchJsonResult;
  try {
    res = await fetchJson(fetchImpl, `${cfg.url}/ops`, options.signal, {
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

  const byClientSeq = new Map<number, { seq: number; status: string }>();
  for (const raw of results) {
    const r = raw as { client_seq?: unknown; seq?: unknown; status?: unknown };
    if (
      typeof r.client_seq === "number" &&
      typeof r.seq === "number" &&
      typeof r.status === "string"
    ) {
      byClientSeq.set(r.client_seq, { seq: r.seq, status: r.status });
    }
  }

  const conflicts: Op[] = [];
  let delivered = 0;
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
    }
    markAcked(db, w.id, r.seq);
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
  /** Conflict-flagged remote ops (applied, then surfaced — see module header). */
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
  const cfg = readEndpointConfig(db);
  if (!cfg.connected) {
    return {
      polled: 0,
      applied: 0,
      conflicts: [],
      cursor: getSyncCursor(db),
      error: "not connected",
    };
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
  const conflicts: Op[] = [];

  for (;;) {
    let res: FetchJsonResult;
    try {
      res = await fetchJson(
        fetchImpl,
        `${cfg.url}/ops?since=${cursor}&limit=${pageLimit}`,
        options.signal,
        {
          headers: { authorization: `Bearer ${cfg.token}` },
          timeoutMs: options.requestTimeoutMs,
        },
      );
    } catch (err) {
      return { polled, applied, conflicts, cursor, error: describeError(err) };
    }
    if (res.status !== 200) {
      return {
        polled,
        applied,
        conflicts,
        cursor,
        error: `HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
      };
    }
    const body = res.body as { ops?: unknown; next?: unknown } | null;
    if (!body || !Array.isArray(body.ops)) {
      return { polled, applied, conflicts, cursor, error: "malformed GET /ops response" };
    }
    const rows = body.ops as Array<Record<string, unknown>>;

    for (const row of rows) {
      polled++;
      // Own-origin: this is OUR op echoed back from the authoritative log.
      // The local state IS the source for it — skip, do not re-apply.
      if (typeof row.origin === "string" && row.origin === machineId) {
        continue;
      }
      const op = parseOp({
        gid: row.gid,
        kind: row.kind,
        origin: row.origin,
        base_version: row.base_version,
        payload: row.payload,
        created_at: row.created_at,
      });
      if (op === null) {
        // Fail closed: never advance the cursor past an op we cannot
        // understand (a client/server version skew must be an incident, not a
        // silent skip of history).
        return {
          polled,
          applied,
          conflicts,
          cursor,
          error: `refusing to advance past malformed op (seq ${String(row.seq)})`,
        };
      }
      try {
        await applyRemoteOp(op, { db });
        applied++;
      } catch (err) {
        return {
          polled,
          applied,
          conflicts,
          cursor,
          error: `failed to apply seq ${String(row.seq)}: ${describeError(err)}`,
        };
      }
      if (row.status === "conflict") {
        // Applied (the log is authoritative) and surfaced for the Phase 5
        // Conflict Manager (fork copy + 4-way resolution).
        conflicts.push(op);
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

  return { polled, applied, conflicts, cursor, error: null };
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
   * idle cadence so a mid-run `connectEndpoint` is picked up).
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
    // connectEndpoint / disconnectEndpoint / poll-interval change takes effect
    // on the very next tick, with no loop restart.
    const cfg = readEndpointConfig(db);
    const activeMs = options.activePollIntervalMs ?? cfg.activePollIntervalMs;
    const idleMs = options.idlePollIntervalMs ?? cfg.idlePollIntervalMs;

    if (!cfg.connected) {
      // Dormant: no requests at all. Re-check on the idle cadence so a
      // mid-run `kontexta endpoint connect` is picked up without a restart.
      st.consecutiveFailures = 0;
      st.backoffMs = 0;
      return { phase: "disconnected", push: null, pull: null, nextDelayMs: idleMs };
    }

    let push: PushResult | null = null;
    let pull: PullResult | null = null;
    let error: string | null = null;
    try {
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
      const cfg = readEndpointConfig(db);
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
