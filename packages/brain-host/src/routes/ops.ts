/**
 * Ops + health routes of the brain host.
 *
 *   GET  /health        liveness + version (no auth)
 *   GET  /ops           poll ops after a cursor (token)
 *   POST /ops           ship a batch of ops (token)
 *
 * Every request is scoped to the brain its token belongs to. The server never interprets a payload:
 * it orders ops, versions each (gid, kind family), parks losing ops as conflicts, and keeps the log forever.
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import { validateClientToken, DEFAULT_PEPPER } from "../auth.js";
import { BrainStore, type NewOp } from "../store.js";
import { VERSION } from "../index.js";

const GID_RE = /^\d+@.+/;

export const OP_KINDS: readonly string[] = [
  "file.create",
  "file.update",
  "file.delete",
  "file.move",
  "folder.create",
  "folder.delete",
  "tag.set",
  "favorite.set",
  "project.register",
  "project.unregister",
  "calendar.entity.upsert",
  "calendar.event.upsert",
  "calendar.link.upsert",
  "journal.meta.upsert",
];

/** Mirrors `kindFamily` in kxta-core (the server does not import core). */
export function kindFamily(kind: string): string {
  if (kind.startsWith("file.")) return "content";
  if (kind === "tag.set" || kind === "favorite.set") return "metadata";
  if (kind.startsWith("folder.")) return "folder";
  if (kind.startsWith("project.")) return "project";
  if (kind === "journal.meta.upsert") return "journal";
  return kind;
}

export const DEFAULT_OPS_LIMIT = 200;
export const MAX_OPS_LIMIT = 1000;

export interface GetOpsParams {
  since: number;
  limit: number;
}

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
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** One validated incoming op (see {@link validateIncomingOp}). */
export type ValidatedOp = NewOp;

export interface OpsRouterOptions {
  pepper?: string;
  defaultLimit?: number;
}

/** Resolve the bearer token to its brain and machine, or null. */
export function authenticate(
  db: Database.Database,
  header: string | undefined,
  pepper: string,
): { brainId: number; machineId: string } | null {
  const token = extractBearerToken(header);
  return token ? validateClientToken(db, token, pepper) : null;
}

export function createOpsRouter(db: Database.Database, options: OpsRouterOptions = {}): Hono {
  const pepper = options.pepper ?? DEFAULT_PEPPER;
  const defaultLimit = Math.min(options.defaultLimit ?? DEFAULT_OPS_LIMIT, MAX_OPS_LIMIT);
  const store = new BrainStore(db);
  const router = new Hono();

  router.get("/health", (c) =>
    c.json({ status: "ok", service: "kontexta-brain-host", version: VERSION, time: Date.now() }),
  );

  router.get("/ops", (c) => {
    const who = authenticate(db, c.req.header("authorization"), pepper);
    if (who === null) return c.json({ error: "unauthorized" }, 401);
    const params = parseGetOpsParams(c.req.query("since"), c.req.query("limit"), defaultLimit);
    if (params === null) return c.json({ error: "since/limit must be non-negative integers" }, 400);
    const rawAcked = c.req.query("acked");
    const acked = rawAcked === undefined ? undefined : Number(rawAcked);
    if (acked !== undefined && (!Number.isInteger(acked) || acked < 0)) {
      return c.json({ error: "acked must be a non-negative integer" }, 400);
    }
    const ops = store.opsSince(who.brainId, params.since, params.limit);
    store.touchMachine(who.brainId, who.machineId, acked);
    return c.json({ ops, next: ops.length > 0 ? ops[ops.length - 1].seq : params.since });
  });

  router.post("/ops", async (c) => {
    const who = authenticate(db, c.req.header("authorization"), pepper);
    if (who === null) return c.json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const rawOps: unknown = Array.isArray(body) ? body : (body as Record<string, unknown> | null)?.ops;
    if (!Array.isArray(rawOps)) {
      return c.json({ error: 'body must be an array of ops or { "ops": [...] }' }, 400);
    }
    if (rawOps.length === 0) return c.json({ machine_id: who.machineId, results: [] });
    if (rawOps.length > MAX_OPS_LIMIT) {
      return c.json({ error: `batch too large (max ${MAX_OPS_LIMIT} ops)` }, 400);
    }

    const validated: ValidatedOp[] = [];
    for (let i = 0; i < rawOps.length; i++) {
      const op = validateIncomingOp(rawOps[i]);
      if (op === null) return c.json({ error: `ops[${i}] is malformed`, index: i }, 400);
      if (op.origin !== who.machineId) {
        return c.json({ error: `ops[${i}] origin does not match the authenticated machine`, index: i }, 403);
      }
      validated.push(op);
    }

    const results = db.transaction(() => {
      const out: Array<{ client_seq: number | null; seq: number; status: "accepted" | "conflict"; duplicate: boolean; version: number }> = [];
      // A later op of the same record in this batch is based on an earlier one; if that lost, so does it.
      const lostInBatch = new Set<string>();
      for (const op of validated) {
        if (op.client_seq !== null) {
          const existing = store.findByClientSeq(who.brainId, op.origin, op.client_seq);
          if (existing) {
            out.push({ client_seq: op.client_seq, seq: existing.seq, status: existing.status, duplicate: true, version: existing.version });
            continue;
          }
        }
        const family = kindFamily(op.kind);
        const key = `${op.gid}|${family}`;
        const current = store.currentVersion(who.brainId, op.gid, family);
        const stale = op.base_version === null ? current > 0 : op.base_version < current;
        const status: "accepted" | "conflict" = stale || lostInBatch.has(key) ? "conflict" : "accepted";
        if (status === "conflict") lostInBatch.add(key);
        const res = store.appendOp(who.brainId, op, family, status);
        out.push({ client_seq: op.client_seq, seq: res.seq, status, duplicate: false, version: res.version });
      }
      store.touchMachine(who.brainId, who.machineId);
      return out;
    })();

    return c.json({ machine_id: who.machineId, results });
  });

  return router;
}

/** Validate one incoming op (fail closed); null when malformed. Accepts an optional `client_seq` used only for retry dedup. */
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
