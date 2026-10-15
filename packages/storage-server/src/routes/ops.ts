/**
 * Storage-server HTTP routes — Phase 4 (storage/04-server).
 *
 * The four endpoints of the authoritative op-log backend (spec 1.6–1.7):
 *
 *   GET  /health          liveness + package version (no auth)
 *   POST /clients         machine registration; issues a one-time sync token
 *   GET  /ops             poll new ops: `?since=<cursor>&limit=<n>` (auth)
 *   POST /ops             ship a batch of local outbox ops (auth)
 *
 * Design notes
 * ============
 *
 * AUTH — `POST /clients` is the ONLY unauthenticated route. Every machine
 * presents `machine_id` (its stable 16-hex identity, the same value its local
 * store keeps in `settings.machine_id`) and receives a fresh 256-bit token,
 * returned exactly ONCE; only its peppered hash is stored (auth.ts). All other
 * routes require `Authorization: Bearer <token>` and resolve the owning
 * `machine_id` via `validateClientToken` — an unknown token is 401.
 *
 * ORDERING (spec 1.7) — the SERVER assigns the sole authoritative order:
 * each accepted op gets the next `ops.seq` (AUTOINCREMENT). Client clocks
 * (`created_at`) are stored for display only and never used to order.
 *
 * CONFLICT DETECTION (spec 1.7) — before an op is appended, the server counts
 * the ops already stored for its `gid` (`COUNT(*)`, all statuses: the log is
 * append-only, so stored == applied). That count is the current canonical
 * version for the gid, starting at 0. An op whose `base_version` (the last
 * version its client knew) is LOWER than that version — or that is a create
 * (`null`) for a gid that already has ops — is stored with `status =
 * 'conflict'` and flagged in the response; the receiving client forks a
 * conflict copy (spec 1.7) instead of clobbering its canonical record.
 *
 *   * `base_version: null` (create) asserts "no prior state": accepted for a
 *     fresh gid, CONFLICT when the gid already has ops — the offline-both-
 *     create case the roundtrip/integration tests exercise.
 *   * `base_version: N` (an update based on version N, the last version the
 *     client knew) is accepted while the canonical version is N and conflicts
 *     once the gid's version has advanced past it (N < version).
 *
 *   CLIENT PROTOCOL — the op's `base_version` is meaningful only if the client
 *   sends the LAST version it knew for the gid. The Phase-3 write sites
 *   hardcode `base_version: 0` (a "mutation" marker, not a version counter),
 *   so the M68 sync loop (kxta-core `storage/client.ts`) rewrites each
 *   outbound op's `base_version` at send time from the local per-gid
 *   high-water mark (max server version known for that gid). This module
 *   documents the contract the loop must honor.
 *
 *   The server NEVER rejects or drops a conflicting op: it stays in the log
 *   (the authoritative record of what happened) and is served to OTHER
 *   machines; only its `status` and the response flag tell the client how to
 *   treat it.
 *
 * IDEMPOTENT RETRIES — a batch may be retried after a lost ACK. The partial
 * unique index `idx_ops_origin_clientseq` (schema.sql) makes a repeat of
 * `(origin, client_seq)` a no-op that returns the ORIGINAL seq instead of
 * double-storing.
 *
 * ATOMICITY — each `POST /ops` runs in a single better-sqlite3 transaction:
 * the per-op version counts, inserts, and dedup checks commit together, so
 * two concurrent batches from the same machine interleave op-by-op with
 * consistent counts (SQLite serializes writers; busy_timeout in db/index.ts
 * absorbs the wait).
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  generateClientToken,
  hashToken,
  validateClientToken,
  isClientKnown,
  DEFAULT_PEPPER,
} from "../auth.js";
import { VERSION } from "../index.js";

/** The `machine_id` a machine may present at POST /clients: the same 16-hex
 *  identity the client keeps in `settings.machine_id`. */
const MACHINE_ID_RE = /^[0-9a-f]{16}$/;

/** GID shape: `<non-negative-integer>@<non-empty>` (mirrors core parseGid). */
const GID_RE = /^\d+@.+/;

/**
 * The closed set of mutation kinds an op may carry. Mirrors `OP_KINDS` in
 * kxta-core (packages/core/src/storage/op.ts); the server is a standalone
 * deployment and does NOT import core, so it re-declares the set. The two
 * lists must stay in lockstep: a client and server on mismatched versions
 * fail closed (400) rather than silently mis-applying an unknown kind.
 */
export const OP_KINDS: readonly string[] = [
  "file.create",
  "file.update",
  "file.delete",
  "file.move",
  "folder.create",
  "folder.delete",
  "tag.add",
  "tag.remove",
  "favorite.set",
  "project.register",
  "project.unregister",
  "calendar.entity.upsert",
  "calendar.event.upsert",
  "calendar.link.upsert",
  "journal.meta.upsert",
];

/** Default batch size for GET /ops when the client sends no `limit`. */
export const DEFAULT_OPS_LIMIT = 200;
/** Hard cap on any single GET /ops batch or POST /ops batch. */
export const MAX_OPS_LIMIT = 1000;

/** Parsed `since` / `limit` query params for GET /ops. */
export interface GetOpsParams {
  since: number;
  limit: number;
}

/**
 * Parse `since` / `limit` query params for GET /ops.
 *
 * `since` defaults to 0 (fetch from the beginning — matches the client's
 * `sync_cursor.last_seq` seed); an absent `limit` falls back to the
 * deployment's configured default (`defaultLimit`, 200 by factory default),
 * and any explicit value is capped at {@link MAX_OPS_LIMIT} so a single poll
 * can never grow unbounded.
 *
 * Returns `null` for anything malformed (non-integer, negative, or an EMPTY
 * string — `Number("") === 0` would silently coerce `?since=` into "from the
 * beginning", a guess rather than a request); the caller answers 400.
 */
export function parseGetOpsParams(
  rawSince: string | undefined,
  rawLimit: string | undefined,
  defaultLimit: number = DEFAULT_OPS_LIMIT,
): GetOpsParams | null {
  // An EMPTY string is malformed — `Number("") === 0` would silently coerce
  // `?since=` to "from the beginning", which is a guess, not a request.
  const since = rawSince === undefined ? 0 : rawSince === "" ? NaN : Number(rawSince);
  if (!Number.isInteger(since) || since < 0) return null;
  const limit = rawLimit === undefined ? defaultLimit : rawLimit === "" ? NaN : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return null;
  // Only the ABSENT-param default comes from the deployment; an explicit
  // `limit` is the client's choice, bounded only by the hard cap.
  return { since, limit: Math.min(limit, MAX_OPS_LIMIT) };
}

/**
 * Extract and normalize a Bearer token from an Authorization header value.
 * Accepts `Bearer <token>` (case-insensitive scheme, surrounding whitespace
 * tolerated). Anything else — missing header, wrong scheme, empty token —
 * yields `null` (the caller answers 401 without revealing which part failed).
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** One op row as served / stored: the six Op fields + server bookkeeping. */
export interface StoredOp {
  seq: number;
  gid: string;
  kind: string;
  origin: string;
  base_version: number | null;
  /** Decoded `op.payload` (the column holds its canonical JSON). */
  payload: unknown;
  created_at: number;
  client_seq: number | null;
  status: "accepted" | "conflict";
  received_at: number;
}

/** An op after server-side validation (see {@link validateIncomingOp}). */
export interface ValidatedOp {
  gid: string;
  kind: string;
  origin: string;
  base_version: number | null;
  /** Canonical JSON of `op.payload` — exactly what the column stores. */
  payloadJson: string;
  created_at: number;
  client_seq: number | null;
}

/** Per-op result of a POST /ops batch. */
export interface OpPostResult {
  /** The client's local outbox id, echoed back (null when not sent). */
  client_seq: number | null;
  /** The server-assigned authoritative seq (the ACK cursor). */
  seq: number;
  /** `conflict` when the op lost optimistic concurrency (spec 1.7). */
  status: "accepted" | "conflict";
  /** True when this (origin, client_seq) was already stored (retry). */
  duplicate: boolean;
}

interface OpsRouterOptions {
  /** The pepper bound into token hashes (override `DEFAULT_PEPPER`). */
  pepper?: string;
  /** Default batch size for GET /ops (capped at {@link MAX_OPS_LIMIT}). */
  defaultLimit?: number;
}

/**
 * Build the ops router bound to a live database.
 *
 * Exported as a factory (not a singleton) so each deployment — and each test —
 * wires its own connection + pepper. The Hono app (server.ts) mounts it at the
 * root; nothing here owns the HTTP listener or process lifecycle.
 */
export function createOpsRouter(
  db: Database.Database,
  options: OpsRouterOptions = {},
): Hono {
  const pepper = options.pepper ?? DEFAULT_PEPPER;
  const defaultLimit = Math.min(options.defaultLimit ?? DEFAULT_OPS_LIMIT, MAX_OPS_LIMIT);
  const router = new Hono();

  // Prepared statements, created once against the bound connection.
  const insertOp = db.prepare(
    `INSERT INTO ops (gid, kind, origin, base_version, payload, created_at, client_seq, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const countGidOps = db.prepare(`SELECT COUNT(*) AS n FROM ops WHERE gid = ?`);
  const findByClientSeq = db.prepare(
    `SELECT seq, status FROM ops WHERE origin = ? AND client_seq = ?`,
  );
  const fetchSince = db.prepare(
    `SELECT seq, gid, kind, origin, base_version, payload, created_at, client_seq, status, received_at
     FROM ops WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
  );
  const touchClient = db.prepare(
    `UPDATE clients SET last_seen_at = ? WHERE machine_id = ?`,
  );

  /**
   * Liveness + package version (no auth): load balancers / Cloud Run probe
   * this path, so it must not require credentials.
   */
  router.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "kontexta-storage-server",
      version: VERSION,
      time: Date.now(),
    }),
  );

  /**
   * Machine registration — the ONLY unauthenticated route.
   *
   * Body: `{ "machine_id": "<16-hex>", "hostname": "<optional label>" }`.
   *
   * First contact issues a fresh token (returned ONCE, never stored in the
   * clear). A machine that registers again gets NO token — it already holds
   * one; the response says so explicitly so a lost token is an operational
   * incident (delete the row) rather than a silent re-issue.
   */
  router.post("/clients", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    const { machine_id, hostname } = body as Record<string, unknown>;
    if (typeof machine_id !== "string" || !MACHINE_ID_RE.test(machine_id)) {
      return c.json(
        { error: "machine_id must be a 16-character lowercase hex string" },
        400,
      );
    }
    const host =
      typeof hostname === "string" && hostname.length > 0 && hostname.length <= 255
        ? hostname
        : null;

    const now = Date.now();
    if (isClientKnown(db, machine_id)) {
      // Re-registration: refresh the label/seen time, issue nothing.
      db.prepare(
        `UPDATE clients SET hostname = COALESCE(?, hostname), last_seen_at = ?
         WHERE machine_id = ?`,
      ).run(host, now, machine_id);
      return c.json({ machine_id, registered: false, token: null });
    }

    const token = generateClientToken();
    db.prepare(
      `INSERT INTO clients (machine_id, hostname, token_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(machine_id, host, hashToken(token, pepper), now, now);
    return c.json({ machine_id, registered: true, token }, 201);
  });

  /**
   * Poll new ops — the sync-loop hot path (spec 1.6).
   *
   * `?since=<cursor>` serves ops with `seq > since` in seq order. The cursor
   * is the client's `sync_cursor.last_seq`; the client advances it to the
   * highest seq it applied. `?limit=<n>` caps the batch. An empty result is a
   * normal 200 `{ ops: [], next: since }` — the short-polling idle case that
   * keeps serverless vCPUs asleep between polls.
   */
  router.get("/ops", (c) => {
    const token = extractBearerToken(c.req.header("authorization"));
    const machineId = token ? validateClientToken(db, token, pepper) : null;
    if (machineId === null) return c.json({ error: "unauthorized" }, 401);

    const params = parseGetOpsParams(
      c.req.query("since"),
      c.req.query("limit"),
      defaultLimit,
    );
    if (params === null) {
      return c.json({ error: "since/limit must be non-negative integers" }, 400);
    }

    const rows = (fetchSince.all(params.since, params.limit) as Array<{
      seq: number;
      gid: string;
      kind: string;
      origin: string;
      base_version: number | null;
      payload: string;
      created_at: number;
      client_seq: number | null;
      status: "accepted" | "conflict";
      received_at: number;
    }>).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    touchClient.run(Date.now(), machineId);

    return c.json({
      ops: rows,
      // The cursor for the NEXT poll: the highest seq served, or the input
      // cursor unchanged when the batch was empty.
      next: rows.length > 0 ? rows[rows.length - 1].seq : params.since,
    });
  });

  /**
   * Ship a batch of local outbox ops (spec 1.6).
   *
   * Body: an array of ops, or `{ "ops": [...] }`. Each op is validated
   * field-by-field (fail closed, mirroring kxta-core's `parseOp` — see
   * {@link validateIncomingOp}); a malformed op rejects the WHOLE batch with
   * 400 so the client fixes its outbox rather than getting a half-applied
   * batch.
   *
   * Response: per op — its server-assigned `seq`, the `status`
   * (`accepted` | `conflict`, spec 1.7), and a `duplicate` flag. A retried
   * `(origin, client_seq)` returns the ORIGINAL seq with `duplicate: true`
   * instead of double-storing.
   */
  router.post("/ops", async (c) => {
    const token = extractBearerToken(c.req.header("authorization"));
    const machineId = token ? validateClientToken(db, token, pepper) : null;
    if (machineId === null) return c.json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const rawOps: unknown = Array.isArray(body)
      ? body
      : (body as Record<string, unknown> | null)?.ops;
    if (!Array.isArray(rawOps)) {
      return c.json(
        { error: "body must be an array of ops or { \"ops\": [...] }" },
        400,
      );
    }
    if (rawOps.length === 0) {
      return c.json({ machine_id: machineId, results: [] });
    }
    if (rawOps.length > MAX_OPS_LIMIT) {
      return c.json({ error: `batch too large (max ${MAX_OPS_LIMIT} ops)` }, 400);
    }

    // Validate the whole batch BEFORE touching the DB (fail closed).
    const validated: ValidatedOp[] = [];
    for (let i = 0; i < rawOps.length; i++) {
      const op = validateIncomingOp(rawOps[i]);
      if (op === null) {
        return c.json({ error: `ops[${i}] is malformed`, index: i }, 400);
      }
      validated.push(op);
    }

    // One transaction per batch: per-op version counts, inserts, and dedup
    // checks commit together (SQLite serializes writers; busy_timeout in
    // db/index.ts absorbs contention).
    const results = db.transaction(() => {
      const out: OpPostResult[] = [];
      for (const op of validated) {
        // 1. Idempotent-retry dedup (partial unique index, schema.sql).
        if (op.client_seq !== null) {
          const existing = findByClientSeq.get(op.origin, op.client_seq) as
            | { seq: number; status: string }
            | undefined;
          if (existing) {
            out.push({
              client_seq: op.client_seq,
              seq: existing.seq,
              status: existing.status === "conflict" ? "conflict" : "accepted",
              duplicate: true,
            });
            continue;
          }
        }

        // 2. Conflict detection (spec 1.7): the canonical version for the gid
        //    is the count of ops already stored for it (append-only log, so
        //    stored == applied). A create (`base_version: null`) asserts "no
        //    prior state" and conflicts iff the gid already has ops (the
        //    offline-both-create case). An update (`base_version: N`, the last
        //    version the client knew) conflicts iff N < currentVersion.
        const currentVersion = (countGidOps.get(op.gid) as { n: number }).n;
        const status: "accepted" | "conflict" =
          op.base_version === null
            ? currentVersion > 0
              ? "conflict"
              : "accepted"
            : op.base_version < currentVersion
              ? "conflict"
              : "accepted";

        // 3. Append: the server assigns the authoritative seq (spec 1.7).
        const info = insertOp.run(
          op.gid,
          op.kind,
          op.origin,
          op.base_version,
          op.payloadJson,
          op.created_at,
          op.client_seq,
          status,
        );
        out.push({
          client_seq: op.client_seq,
          seq: Number(info.lastInsertRowid),
          status,
          duplicate: false,
        });
      }
      touchClient.run(Date.now(), machineId);
      return out;
    })();

    return c.json({ machine_id: machineId, results });
  });

  return router;
}

/**
 * Validate one incoming op (fail closed, mirroring kxta-core's `parseOp`).
 *
 * Returns the validated op or `null` — never throws. Accepts one EXTRA
 * optional field, `client_seq` (the client's local outbox id: positive
 * integer or null), used ONLY for retry dedup — it is not part of the Op
 * schema and is never forwarded into the payload.
 */
export function validateIncomingOp(raw: unknown): ValidatedOp | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.gid !== "string" || !GID_RE.test(r.gid)) return null;

  if (typeof r.kind !== "string" || !OP_KINDS.includes(r.kind)) return null;

  if (typeof r.origin !== "string" || r.origin.length === 0) return null;

  if (
    r.base_version !== null &&
    !(Number.isInteger(r.base_version) && (r.base_version as number) >= 0)
  ) {
    return null;
  }

  if (typeof r.created_at !== "number" || !Number.isFinite(r.created_at)) return null;

  // Payload must be JSON-serializable (functions/symbols/undefined are not).
  const payloadJson = JSON.stringify(r.payload);
  if (typeof payloadJson !== "string") return null;

  const clientSeq = r.client_seq;
  if (
    clientSeq !== undefined &&
    clientSeq !== null &&
    !(Number.isInteger(clientSeq) && (clientSeq as number) > 0)
  ) {
    return null;
  }

  return {
    gid: r.gid,
    kind: r.kind,
    origin: r.origin,
    base_version: r.base_version as number | null,
    payloadJson,
    created_at: r.created_at as number,
    client_seq: (clientSeq as number | null) ?? null,
  };
}
