import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { OP_KINDS, parseOp, type Op } from "../../src/storage/op.js";
import {
  enqueueOp,
  pendingOps,
  pendingCount,
  markSent,
  markAcked,
  markFailed,
} from "../../src/storage/outbox.js";

// TDD contract for the Phase 3 outbox queue (src/storage/outbox.ts, created in
// the following milestone). It runs RED today because that module is absent:
// the import below fails to resolve, so the whole file is an error. It turns
// GREEN once outbox.ts lands and satisfies this contract:
//
//   outbox.ts -> enqueueOp(db, op: Op): number,
//                pendingOps(db): { id: number; op: Op }[],
//                pendingCount(db): number,
//                markSent(db, ids: number[]): void,
//                markAcked(db, id: number, serverSeq: number): void,
//                markFailed(db, id: number, error: string, nextAttemptAt: number): void
//
// The queue is a thin, transactional layer over the `outbox` table (migration
// 014). Invariants pinned here (implementation freedom is left for the rest):
//
//   APPEND-ONLY — enqueueOp appends one row and returns its local seq (the
//     outbox.id / AUTOINCREMENT). Local seq is the ONLY local ordering signal;
//     created_at is never used to order.
//   TRANSACTIONAL — enqueueOp reuses the caller's open transaction (spec 1.3:
//     the op is appended "within the same SQLite transaction" as the write). A
//     rolled-back caller transaction must discard the op; a committed one must
//     persist it. enqueueOp must NOT commit on its own.
//   STRICT — enqueueOp rejects a malformed op (never enqueues a corrupt row).
//   STATE MACHINE — pending -> sent -> acked | failed (spec 1.3). Each
//     transition is observable on the `outbox` row's status / server_seq /
//     attempts / next_attempt_at / last_error columns.
//   RECONSTRUCTABLE — pendingOps yields the op back as a validated Op (payload
//     round-trips through the codec in src/storage/op.ts).

const MID = "4f9e1a8b3c7d2e0f";
/** A well-formed GID for local record `n` on machine MID. */
const gid = (n: number): string => `${n}@${MID}`;

/** A fully well-formed Op; `overrides` perturbs a single field. */
function validOp(n: number, overrides: Record<string, unknown> = {}): Op {
  return {
    gid: gid(n),
    kind: "file.update",
    origin: MID,
    base_version: 3,
    payload: { path: `/kb/a/f${n}.md`, content: `content-${n}` },
    created_at: 1_700_000_000_000 + n,
    ...overrides,
  } as unknown as Op;
}

/** A codec "rejects" input iff it returns null/undefined OR throws. */
function isRejected(fn: () => unknown): boolean {
  try {
    return fn() == null;
  } catch {
    return true;
  }
}

/** Read a raw outbox row's delivery-state columns (the observable contract). */
function outboxRow(
  db: ReturnType<typeof createDatabase>,
  id: number,
): {
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
} {
  return db
    .prepare(
      `SELECT id, gid, kind, origin, base_version, payload, created_at,
              status, attempts, next_attempt_at, last_error, server_seq
       FROM outbox WHERE id = ?`,
    )
    .get(id) as any;
}

describe("Outbox queue (src/storage/outbox.ts)", () => {
  let testDir: string;
  const tempDbs: string[] = [];

  const mkDbPath = (): string => {
    if (!testDir) testDir = mkdtempSync(join(tmpdir(), "kontexta-outbox-"));
    const p = join(testDir, `${tempDbs.length + 1}.db`);
    tempDbs.push(p);
    return p;
  };

  afterEach(() => {
    closeDatabase(); // clear the shared singleton opened by createDatabase
    for (const p of tempDbs) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(p + suffix, { force: true });
        } catch {}
      }
    }
    tempDbs.length = 0;
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = "";
    }
  });

  describe("enqueueOp (append)", () => {
    it("appends an op and returns an incrementing local seq", () => {
      const db = createDatabase(mkDbPath());
      const a = enqueueOp(db, validOp(1));
      const b = enqueueOp(db, validOp(2));
      const c = enqueueOp(db, validOp(3));
      // Local seq must be a strictly increasing integer sequence.
      expect(Number.isInteger(a)).toBe(true);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
    });

    it("stores the op's schema fields verbatim (reconstructed via parseOp)", () => {
      const db = createDatabase(mkDbPath());
      const op = validOp(7, { kind: "file.create", base_version: null });
      const id = enqueueOp(db, op);

      const row = outboxRow(db, id);
      expect(row.gid).toBe(op.gid);
      expect(row.kind).toBe(op.kind);
      expect(row.origin).toBe(op.origin);
      expect(row.base_version, "a null base_version must be stored as NULL").toBeNull();
      expect(row.status, "a fresh op must be 'pending'").toBe("pending");
      expect(row.attempts, "a fresh op must have 0 attempts").toBe(0);
      // The payload must round-trip through the canonical codec.
      expect(JSON.parse(row.payload)).toEqual(op.payload);
      // And the whole row must re-parse to the original op.
      const reconstructed = parseOp({
        gid: row.gid,
        kind: row.kind,
        origin: row.origin,
        base_version: row.base_version,
        payload: JSON.parse(row.payload),
        created_at: row.created_at,
      });
      expect(reconstructed, "the stored row must re-parse to a valid Op").not.toBeNull();
      expect(reconstructed).toEqual(op);
    });

    it("accepts every spec mutation kind and a null / primitive payload", () => {
      const db = createDatabase(mkDbPath());
      for (const kind of OP_KINDS) {
        const id = enqueueOp(db, validOp(1, { kind }));
        expect(outboxRow(db, id).kind, `kind ${kind} must be stored`).toBe(kind);
      }
      for (const payload of [null, "a string", 42, false]) {
        const id = enqueueOp(db, validOp(1, { payload }));
        expect(JSON.parse(outboxRow(db, id).payload), "payload must round-trip").toEqual(payload);
      }
    });

    it("rejects a malformed op (never enqueues a corrupt row)", () => {
      const db = createDatabase(mkDbPath());
      const before = pendingCount(db);
      // A non-Op and an Op with an unknown kind must both be rejected.
      expect(isRejected(() => enqueueOp(db, "not-an-op" as unknown as Op))).toBe(true);
      expect(isRejected(() => enqueueOp(db, validOp(1, { kind: "bogus.kind" })))).toBe(true);
      // Rejection must not leave a partial row behind.
      expect(pendingCount(db), "a rejected enqueue must not add a row").toBe(before);
    });

    it("participates in the caller's transaction: a rollback discards the op", () => {
      const db = createDatabase(mkDbPath());
      expect(pendingCount(db)).toBe(0);
      expect(() =>
        db.transaction(() => {
          enqueueOp(db, validOp(1));
          throw new Error("simulate the write rolling back");
        })(),
      ).toThrow();
      expect(
        pendingCount(db),
        "an op enqueued inside a rolled-back transaction must not persist",
      ).toBe(0);
    });

    it("participates in the caller's transaction: a commit persists the op", () => {
      const db = createDatabase(mkDbPath());
      const id = db.transaction(() => enqueueOp(db, validOp(1)))();
      expect(pendingCount(db), "an op enqueued inside a committed transaction must persist").toBe(1);
      expect(pendingOps(db).map((e) => e.id)).toEqual([id]);
    });
  });

  describe("pendingOps (drain order)", () => {
    it("returns empty for a fresh outbox", () => {
      const db = createDatabase(mkDbPath());
      expect(pendingOps(db)).toEqual([]);
    });

    it("returns only pending ops in local-seq (id) ascending order", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      const i2 = enqueueOp(db, validOp(2));
      const i3 = enqueueOp(db, validOp(3));
      // Interleave a non-pending op so the test proves pendingOps filters by
      // status (not by mere presence).
      markSent(db, [i2]);

      const entries = pendingOps(db);
      expect(entries.map((e) => e.id)).toEqual([i1, i3]);
      // Each entry must reconstruct its full Op.
      for (const e of entries) {
        expect(typeof e.id, "each entry must carry a numeric id").toBe("number");
        expect(parseOp(e.op), "each entry.op must be a valid Op").not.toBeNull();
      }
      // A mutation's base_version is the version this machine has seen for the gid (0 on a fresh vault).
      expect(entries[0].op).toEqual({ ...validOp(1), base_version: 0 });
      expect(entries[1].op).toEqual({ ...validOp(3), base_version: 0 });
    });

    it("excludes sent, acked, and failed ops", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      const i2 = enqueueOp(db, validOp(2));
      const i3 = enqueueOp(db, validOp(3));
      markSent(db, [i1, i2, i3]);
      markAcked(db, i1, 100);
      markFailed(db, i2, "boom", 9_999_999);
      // i3 is 'sent' (in flight); i1 'acked'; i2 'failed' -> none pending.
      expect(pendingOps(db).map((e) => e.id)).toEqual([]);
    });
  });

  describe("pendingCount (count of pending only)", () => {
    it("is 0 for a fresh outbox", () => {
      const db = createDatabase(mkDbPath());
      expect(pendingCount(db)).toBe(0);
    });

    it("counts only pending ops, not sent/acked/failed", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      const i2 = enqueueOp(db, validOp(2));
      const i3 = enqueueOp(db, validOp(3));
      const i4 = enqueueOp(db, validOp(4));
      expect(pendingCount(db)).toBe(4);

      markSent(db, [i1]);
      markAcked(db, i2, 100);
      markFailed(db, i3, "x", 9_999_999);
      // Only i4 remains pending.
      expect(pendingCount(db), "only un-transitioned ops count as pending").toBe(1);
      expect(pendingOps(db).map((e) => e.id)).toEqual([i4]);
    });
  });

  describe("markSent (pending -> sent)", () => {
    it("moves ops from pending to sent", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      const i2 = enqueueOp(db, validOp(2));
      expect(pendingCount(db)).toBe(2);

      markSent(db, [i1, i2]);
      expect(outboxRow(db, i1).status).toBe("sent");
      expect(outboxRow(db, i2).status).toBe("sent");
      expect(pendingCount(db), "sent ops must no longer count as pending").toBe(0);
      expect(pendingOps(db)).toEqual([]);
    });

    it("is a no-op for unknown ids (does not throw)", () => {
      const db = createDatabase(mkDbPath());
      expect(() => markSent(db, [999_999])).not.toThrow();
    });
  });

  describe("markAcked (sent -> acked, records server seq)", () => {
    it("moves a sent op to acked and records the server-assigned seq", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      markSent(db, [i1]);
      expect(outboxRow(db, i1).server_seq, "not yet acked -> no server seq").toBeNull();

      markAcked(db, i1, 4242);
      const row = outboxRow(db, i1);
      expect(row.status).toBe("acked");
      expect(row.server_seq, "the server-assigned global seq must be recorded").toBe(4242);
      expect(row.attempts, "acking must not change the attempt counter").toBe(0);
    });

    it("is a no-op for unknown ids (does not throw)", () => {
      const db = createDatabase(mkDbPath());
      expect(() => markAcked(db, 999_999, 1)).not.toThrow();
    });
  });

  describe("markFailed (-> failed, attempt counter + backoff)", () => {
    it("moves an op to failed, increments attempts, records backoff + error", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      expect(outboxRow(db, i1).attempts).toBe(0);
      expect(outboxRow(db, i1).next_attempt_at).toBeNull();

      markFailed(db, i1, "connection reset", 1_700_000_000_000);
      const row = outboxRow(db, i1);
      expect(row.status).toBe("failed");
      expect(row.attempts, "a failure must increment the attempt counter").toBe(1);
      expect(row.next_attempt_at, "the backoff retry time must be recorded").toBe(
        1_700_000_000_000,
      );
      expect(row.last_error, "the failure reason must be recorded").toBe("connection reset");
      expect(pendingCount(db), "a failed op must not count as pending").toBe(0);
    });

    it("accumulates attempts across repeated failures", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      markFailed(db, i1, "e1", 1_000);
      markFailed(db, i1, "e2", 2_000);
      const row = outboxRow(db, i1);
      expect(row.attempts, "each failure increments the counter").toBe(2);
      expect(row.next_attempt_at).toBe(2_000);
      expect(row.last_error).toBe("e2");
    });

    it("is a no-op for unknown ids (does not throw)", () => {
      const db = createDatabase(mkDbPath());
      expect(() => markFailed(db, 999_999, "x", 1)).not.toThrow();
    });
  });

  describe("full lifecycle (a batch walks the state machine)", () => {
    it("drains pending -> sent -> (acked | failed), preserving order and per-op state", () => {
      const db = createDatabase(mkDbPath());
      const i1 = enqueueOp(db, validOp(1));
      const i2 = enqueueOp(db, validOp(2));
      const i3 = enqueueOp(db, validOp(3));
      expect(pendingOps(db).map((e) => e.id)).toEqual([i1, i2, i3]);

      // The sync loop marks the whole batch sent...
      markSent(db, [i1, i2, i3]);
      expect(pendingCount(db)).toBe(0);

      // ...the server acks two (assigning global seqs) and one fails.
      markAcked(db, i1, 1000);
      markAcked(db, i3, 1002);
      markFailed(db, i2, "conflict", 1_700_000_000_000);

      expect(outboxRow(db, i1).status).toBe("acked");
      expect(outboxRow(db, i1).server_seq).toBe(1000);
      expect(outboxRow(db, i2).status).toBe("failed");
      expect(outboxRow(db, i2).attempts).toBe(1);
      expect(outboxRow(db, i3).status).toBe("acked");
      expect(outboxRow(db, i3).server_seq).toBe(1002);

      // None are pending; nothing was lost.
      expect(pendingCount(db)).toBe(0);
      const total = (db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
      expect(total, "all three ops must still be present (append-only)").toBe(3);
    });
  });
});
