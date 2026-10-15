/**
 * Cross-process advisory locks for applying remote ops — Phase 3 (storage/03-outbox).
 *
 * apps/mcp and apps/web run as SEPARATE OS processes against the same SQLite
 * database (WAL mode). The in-memory locks in util/safety.ts protect only
 * intra-process concurrency (spec 1.5), so applying an incoming remote op
 * batch needs a DB-level lock: when both processes pull the same op, only one
 * may apply it for a given gid at a time.
 *
 * Mechanism (spec 1.5, migration 014): the `sync_locks(gid, pid, token,
 * expires_at)` table. Acquisition is a single immediate SQLite transaction —
 * check the row, claim or steal a stale one — so SQLite's per-DB write lock
 * serializes concurrent acquisitions across processes (same precedent as
 * journal/cooldown.ts over journal_locks). Every lock carries an absolute
 * expiry deadline (`expires_at`, ms since epoch): if the holder crashes
 * mid-apply, the lease lapses and another process can steal the row after
 * `expires_at` — a fixed-lease analogue of the journal_locks staleness window.
 * Release must match the ownership `token`, so a late release from a process
 * whose lock was stolen cannot delete the new owner's row.
 *
 * Why the lock wraps the WHOLE apply (not just the INSERT): a remote
 * `file.create` is upsert-shaped (select-by-gid-or-path, then INSERT/UPDATE).
 * If two processes interleave at the statement level, both observe "no row"
 * and both INSERT the same UNIQUE `files.path` — one hits a constraint error
 * and the op is lost. Serializing the complete apply per gid makes each
 * application observe the prior one's committed state (idempotent upsert),
 * which is exactly the cross-process guarantee spec 1.5 requires.
 */

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/index.js";

/** Default lease: long enough for the largest realistic apply (a full-content
 *  file write), short enough that a crashed holder is reclaimable in seconds. */
export const DEFAULT_SYNC_LOCK_LEASE_MS = 30_000;

/** A held sync lock: the gid it guards plus the ownership token for release. */
export interface SyncLockHandle {
  gid: string;
  token: string;
}

/**
 * Acquire the advisory lock for `gid`.
 *
 * - Free row          → INSERT and return the handle.
 * - Held, unexpired   → return `null` (someone else is applying this gid).
 * - Held but stale    → steal it (UPDATE with a fresh token/lease) and return
 *                       the handle. Staleness is `now >= expires_at` — a
 *                       crashed holder's lease lapses and the row is
 *                       reclaimable (spec 1.5).
 *
 * The check+claim runs in one SQLite transaction: under WAL, only one writer
 * can hold the write lock at a time, so two processes racing to acquire the
 * same gid are serialized and exactly one claims it.
 *
 * @param db - explicit handle (caller-owned, testable); defaults to the shared
 *             singleton via {@link getDatabase}.
 * @param leaseMs - absolute lease duration in ms (default 30 s).
 * @param token - optional fixed ownership token; by default a fresh 16-byte
 *                random token is minted.
 */
export function acquireSyncLock(
  gid: string,
  opts: { db?: Database.Database; leaseMs?: number; token?: string } = {},
): SyncLockHandle | null {
  const db = opts.db ?? getDatabase();
  const leaseMs = opts.leaseMs ?? DEFAULT_SYNC_LOCK_LEASE_MS;
  const token = opts.token ?? randomBytes(16).toString("hex");
  const now = Date.now();
  const expiresAt = now + leaseMs;

  // One transaction: the existence check and the claim are atomic vs any
  // concurrent acquireSyncLock in another process (SQLite serializes writers).
  const txn = db.transaction((): SyncLockHandle | null => {
    const existing = db
      .prepare("SELECT pid, token, expires_at FROM sync_locks WHERE gid = ?")
      .get(gid) as { pid: number; token: string; expires_at: number } | undefined;

    if (existing) {
      if (now < existing.expires_at) {
        return null; // live lock — not ours to take
      }
      // Stale (crashed holder, or a negative age from clock skew — treat as
      // reclaimable too, same policy as journal/cooldown.ts). Steal it.
      db.prepare("UPDATE sync_locks SET pid = ?, token = ?, expires_at = ? WHERE gid = ?").run(
        process.pid,
        token,
        expiresAt,
        gid,
      );
      return { gid, token };
    }

    try {
      db.prepare("INSERT INTO sync_locks (gid, pid, token, expires_at) VALUES (?, ?, ?, ?)").run(
        gid,
        process.pid,
        token,
        expiresAt,
      );
      return { gid, token };
    } catch (err) {
      // UNIQUE(gid) PK race with a concurrent process that committed between
      // our SELECT and INSERT: retry the check+claim once inside the txn.
      if (
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        /unique constraint/i.test(String((err as { message: unknown }).message))
      ) {
        const recheck = db
          .prepare("SELECT pid, token, expires_at FROM sync_locks WHERE gid = ?")
          .get(gid) as { pid: number; token: string; expires_at: number } | undefined;
        if (recheck && now >= recheck.expires_at) {
          db.prepare("UPDATE sync_locks SET pid = ?, token = ?, expires_at = ? WHERE gid = ?").run(
            process.pid,
            token,
            expiresAt,
            gid,
          );
          return { gid, token };
        }
        return null;
      }
      throw err;
    }
  });

  return txn.immediate();
}

/**
 * Release a previously acquired lock. The `token` MUST match the one returned
 * by {@link acquireSyncLock} — a mismatched release is a no-op, so a late
 * release from a process whose lock was stolen (after stale-detection) cannot
 * delete the new owner's lock.
 *
 * @returns true if the lock row was actually deleted, false otherwise.
 */
export function releaseSyncLock(
  handle: SyncLockHandle,
  opts: { db?: Database.Database } = {},
): boolean {
  const db = opts.db ?? getDatabase();
  const info = db
    .prepare("DELETE FROM sync_locks WHERE gid = ? AND token = ?")
    .run(handle.gid, handle.token);
  return info.changes > 0;
}

/**
 * Configuration options for {@link withSyncLock}.
 */
export interface WithSyncLockOptions {
  db?: Database.Database;
  leaseMs?: number;
  timeoutMs?: number;
  retryIntervalMs?: number;
}

/**
 * Execute `fn` while holding the cross-process advisory lock for `gid`.
 *
 * If the lock is currently held by another process/worker and unexpired,
 * polls until it is acquired or `timeoutMs` elapses (default 10 s).
 * Releases the lock reliably in a `finally` block using the handle's token.
 *
 * @throws Error if the lock could not be acquired within `timeoutMs`.
 */
export async function withSyncLock<T>(
  gid: string,
  fn: () => Promise<T> | T,
  opts: WithSyncLockOptions = {},
): Promise<T> {
  const db = opts.db ?? getDatabase();
  const leaseMs = opts.leaseMs ?? DEFAULT_SYNC_LOCK_LEASE_MS;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 20;

  const start = Date.now();
  let handle: SyncLockHandle | null = null;

  while (true) {
    handle = acquireSyncLock(gid, { db, leaseMs });
    if (handle !== null) {
      break;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `withSyncLock: timed out after ${elapsed}ms waiting for lock on gid "${gid}"`,
      );
    }
    const jitter = Math.floor(Math.random() * 10);
    const sleepMs = Math.min(retryIntervalMs + jitter, Math.max(1, timeoutMs - elapsed));
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  try {
    return await fn();
  } finally {
    try {
      releaseSyncLock(handle, { db });
    } catch {
      // Best-effort release; if db was closed or connection lost, stale expiry protects it
    }
  }
}

/**
 * Check whether a sync lock is currently held and unexpired for `gid`.
 */
export function isSyncLockHeld(
  gid: string,
  opts: { db?: Database.Database; now?: number } = {},
): boolean {
  const db = opts.db ?? getDatabase();
  const now = opts.now ?? Date.now();
  const row = db
    .prepare("SELECT expires_at FROM sync_locks WHERE gid = ?")
    .get(gid) as { expires_at: number } | undefined;
  return Boolean(row && now < row.expires_at);
}
