/**
 * Snapshot bootstrap after joining a brain.
 *
 * A machine that joined (or switched) a brain pulls the brain's current state instead of replaying its
 * history. An empty machine applies every record. A machine with content keeps files whose content already
 * matches, forks a conflict copy where it differs, and lets path collisions become path conflicts. Progress is
 * kept in settings so an interrupted bootstrap resumes from the last gid.
 */

import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { applyRemoteOp } from "./apply.js";
import { forkConflictFromOp } from "./conflicts.js";
import { UnappliableOpError } from "./errors.js";
import { fetchJson, describeError } from "./http.js";
import { readBrainConfig, settingDelete, settingUpsert, settingValue } from "./brain.js";
import { kindFamily, parseOp, type Op } from "./op.js";
import { recordGidVersion } from "./versions.js";

const PAGE = 200;

export interface BootstrapOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  pageLimit?: number;
}

export interface BootstrapResult {
  mode: "empty" | "merge";
  applied: number;
  forked: number;
  skipped: number;
  cursor: number;
}

export function bootstrapPending(db: Database): boolean {
  return settingValue(db, "brain_bootstrap_pending") === "1";
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function toOp(row: Record<string, unknown>): Op | null {
  return parseOp({
    gid: row.gid,
    kind: row.kind,
    origin: row.origin,
    base_version: null,
    payload: row.payload,
    created_at: row.created_at,
  });
}

function isContentOp(op: Op): boolean {
  return op.kind === "file.create" || op.kind === "file.update";
}

function localFile(db: Database, gid: string): { content_hash: string | null } | undefined {
  return db.prepare("SELECT content_hash FROM files WHERE gid = ?").get(gid) as { content_hash: string | null } | undefined;
}

function recordSkip(db: Database, seq: number, op: Op, err: unknown): void {
  db.prepare(
    `INSERT INTO sync_skipped_ops (seq, gid, kind, origin, error, attempts, skipped, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)
     ON CONFLICT(seq) DO UPDATE SET error = excluded.error, skipped = 1`,
  ).run(seq, op.gid, op.kind, op.origin, describeError(err), Date.now());
}

interface Deferred {
  op: Op;
  seq: number;
  version: number | null;
}

/** True when the op references a project or calendar entity this machine does not have yet. */
function dependsOnMissing(db: Database, op: Op): boolean {
  const p = op.payload as Record<string, unknown>;
  const missing = (table: "projects" | "calendar_entities", gid: unknown): boolean =>
    typeof gid === "string" && gid !== "" && db.prepare(`SELECT 1 FROM ${table} WHERE gid = ?`).get(gid) === undefined;
  return (
    missing("projects", p.project_gid) ||
    missing("calendar_entities", p.entity_gid) ||
    missing("calendar_entities", p.from_entity_gid) ||
    missing("calendar_entities", p.to_entity_gid)
  );
}

/** Runs once after a join; returns null when nothing is pending. Throws on a network or HTTP failure so it can be retried. */
export async function bootstrapIfNeeded(db: Database, opts: BootstrapOptions = {}): Promise<BootstrapResult | null> {
  const cfg = readBrainConfig(db);
  if (!cfg.connected || !bootstrapPending(db)) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const limit = opts.pageLimit ?? PAGE;
  const mode: "empty" | "merge" = (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n === 0 ? "empty" : "merge";

  let after = settingValue(db, "brain_bootstrap_after") ?? "";
  // The cursor is taken from the FIRST page of the whole bootstrap, so ops that land while paging are pulled afterwards.
  let latest = Number(settingValue(db, "brain_bootstrap_latest") ?? 0);
  let deferred: Deferred[] = [];
  try {
    deferred = JSON.parse(settingValue(db, "brain_bootstrap_deferred") ?? "[]") as Deferred[];
  } catch {}
  let applied = 0;
  let forked = 0;
  let skipped = 0;

  const saveDeferred = (): void => settingUpsert(db, "brain_bootstrap_deferred", JSON.stringify(deferred));

  /** Apply one snapshot record; ops whose project or entity has not arrived yet wait for the final pass. */
  const processRecord = async (op: Op, seq: number, version: number | null, finalPass: boolean): Promise<void> => {
    if (!finalPass && dependsOnMissing(db, op)) {
      deferred.push({ op, seq, version });
      saveDeferred();
      return;
    }
    try {
      const local = isContentOp(op) ? localFile(db, op.gid) : undefined;
      if (mode === "merge" && local) {
        const payload = op.payload as { content?: unknown; content_hash?: unknown };
        const remoteHash = typeof payload.content_hash === "string" ? payload.content_hash : sha256(typeof payload.content === "string" ? payload.content : "");
        if (local.content_hash !== remoteHash) {
          forkConflictFromOp(op, db, { serverSeq: seq });
          forked++;
        }
      } else {
        await applyRemoteOp(op, { db });
        applied++;
      }
    } catch (err) {
      if (!(err instanceof UnappliableOpError)) throw err;
      recordSkip(db, seq, op, err);
      skipped++;
    }
    if (version !== null) recordGidVersion(db, op.gid, kindFamily(op.kind), version);
  };

  for (;;) {
    const res = await fetchJson(
      fetchImpl,
      `${cfg.remoteUrl}/brains/snapshot?limit=${limit}&after=${encodeURIComponent(after)}`,
      opts.signal,
      { headers: { authorization: `Bearer ${cfg.token}` }, timeoutMs: opts.requestTimeoutMs },
    );
    const body = res.body as { gids?: unknown; next?: unknown; latest_seq?: unknown } | null;
    if (res.status !== 200 || !body || !Array.isArray(body.gids)) {
      throw new Error(`bootstrap: snapshot request failed (HTTP ${res.status})`);
    }
    if (settingValue(db, "brain_bootstrap_latest") === null && typeof body.latest_seq === "number") {
      latest = body.latest_seq;
      settingUpsert(db, "brain_bootstrap_latest", String(latest));
    }

    for (const entry of body.gids as Array<{ gid: string; records: Array<Record<string, unknown>>; conflicts: Array<Record<string, unknown>> }>) {
      for (const rec of entry.records) {
        if (rec.deleted === true) continue;
        const op = toOp(rec);
        if (op === null) {
          skipped++;
          continue;
        }
        await processRecord(op, typeof rec.seq === "number" ? rec.seq : 0, typeof rec.version === "number" ? rec.version : null, false);
      }
      for (const c of entry.conflicts) {
        const op = toOp(c);
        const local = op === null ? undefined : localFile(db, op.gid);
        if (op === null || !isContentOp(op) || !local) continue;
        // A parked op whose content already matches the canonical file has nothing left to resolve.
        const hash = (op.payload as { content_hash?: unknown }).content_hash;
        if (typeof hash === "string" && hash === local.content_hash) continue;
        try {
          forkConflictFromOp(op, db, { serverSeq: typeof c.seq === "number" ? c.seq : undefined });
          forked++;
        } catch (err) {
          if (!(err instanceof UnappliableOpError)) throw err;
          skipped++;
        }
      }
      after = entry.gid;
      settingUpsert(db, "brain_bootstrap_after", after);
    }
    if (typeof body.next !== "string") break;
  }

  // Projects and entities have all arrived by now, so the ops that waited for them can apply.
  const waiting = deferred;
  deferred = [];
  for (const d of waiting) await processRecord(d.op, d.seq, d.version, true);

  db.prepare("UPDATE sync_cursor SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE id = 1").run(latest, Date.now());
  settingDelete(db, "brain_bootstrap_pending");
  settingDelete(db, "brain_bootstrap_after");
  settingDelete(db, "brain_bootstrap_latest");
  settingDelete(db, "brain_bootstrap_deferred");
  const cursor = (db.prepare("SELECT last_seq FROM sync_cursor WHERE id = 1").get() as { last_seq: number }).last_seq;
  return { mode, applied, forked, skipped, cursor };
}
