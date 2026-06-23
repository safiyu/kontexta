import { randomBytes } from "node:crypto";
import { getDatabase } from "../db/index.js";

interface LockRow {
  token: string;
  pid: number;
  acquired_at: number;
}

function lockKey(projectSlug: string): string {
  return `distill:${projectSlug}`;
}

/**
 * Acquire a distill lock for `projectSlug`. Returns a release token the
 * caller must pass back to releaseCooldown(); release verifies ownership so
 * one process can't unlock another's lock.
 *
 * Stored in SQLite (journal_locks table), which makes it atomic across
 * processes — the per-DB write lock SQLite takes during the transaction
 * serializes concurrent acquire attempts even when distillJournal runs from
 * the MCP server and the web app at the same time. The previous file-based
 * implementation used `openSync(p, "wx")` which is per-process-correct but
 * has known races on networked filesystems and survives across crashes only
 * via a time-based staleness window.
 *
 * Stale recovery: if an existing lock's `acquired_at` is older than
 * `staleAfterSeconds`, it's treated as abandoned and claimed.
 *
 * The `baseDir` parameter is kept for API compatibility with the old
 * file-based signature but is unused.
 */
export function acquireCooldown(
  _baseDir: string,
  projectSlug: string,
  staleAfterSeconds: number,
): string | null {
  const db = getDatabase();
  const key = lockKey(projectSlug);
  const token = randomBytes(16).toString("hex");
  const now = Date.now();

  // Run inside a transaction so the existence check + claim is atomic vs
  // any concurrent acquireCooldown call in another process.
  const txn = db.transaction((): string | null => {
    const existing = db
      .prepare("SELECT token, pid, acquired_at FROM journal_locks WHERE lock_key = ?")
      .get(key) as LockRow | undefined;

    if (existing) {
      const ageMs = now - existing.acquired_at;
      if (ageMs >= 0 && ageMs < staleAfterSeconds * 1000) {
        return null;
      }
      // Stale (or clock drift produced a negative age, which we also treat
      // as needing a fresh claim). Claim by overwriting.
      db.prepare(
        "UPDATE journal_locks SET token = ?, pid = ?, acquired_at = ? WHERE lock_key = ?",
      ).run(token, process.pid, now, key);
      return token;
    }

    db.prepare(
      "INSERT INTO journal_locks (lock_key, token, pid, acquired_at) VALUES (?, ?, ?, ?)",
    ).run(key, token, process.pid, now);
    return token;
  });

  return txn();
}

/**
 * Release a lock. The token MUST match the one returned by acquireCooldown —
 * mismatched tokens are a no-op so a late release from a process whose lock
 * was taken over (after stale-detection) doesn't deactivate the new owner's
 * lock.
 */
export function releaseCooldown(
  _baseDir: string,
  projectSlug: string,
  token: string,
): void {
  const db = getDatabase();
  db.prepare("DELETE FROM journal_locks WHERE lock_key = ? AND token = ?").run(
    lockKey(projectSlug),
    token,
  );
}
