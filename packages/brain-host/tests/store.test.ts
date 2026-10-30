import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { BrainStore, type NewOp } from "../src/store.js";

const op = (gid: string, kind: string, base: number | null, extra: Record<string, unknown> = {}): NewOp => ({
  gid, kind, origin: "aaaaaaaaaaaaaaaa", base_version: base, payloadJson: JSON.stringify({ content_hash: "h-" + kind, ...extra }),
  created_at: 1, client_seq: null,
});

describe("BrainStore", () => {
  let store: BrainStore;
  let a: number;
  let b: number;
  beforeEach(() => {
    store = new BrainStore(openDatabase(":memory:"));
    a = store.createBrain("hash-a", "A");
    b = store.createBrain("hash-b", "B");
  });

  it("appendOp increments the version per (gid, kind_family) and materializes records", () => {
    const g = "1@aaaaaaaaaaaaaaaa";
    expect(store.appendOp(a, op(g, "file.create", null), "content", "accepted").version).toBe(1);
    expect(store.appendOp(a, op(g, "file.update", 1), "content", "accepted").version).toBe(2);
    expect(store.appendOp(a, op(g, "tag.set", 0), "metadata", "accepted").version).toBe(1);
    expect(store.currentVersion(a, g, "content")).toBe(2);
    expect(store.currentVersion(a, g, "metadata")).toBe(1);
    expect(store.snapshotPage(a, "", 10, true).gids[0].records.map((r) => r.kind).sort()).toEqual(["file.create", "file.update", "tag.set"]);
  });

  it("a conflict-flagged op lands in conflicts, not records, and a later accepted op with a higher base clears it", () => {
    const g = "2@aaaaaaaaaaaaaaaa";
    store.appendOp(a, op(g, "file.create", null), "content", "accepted");
    store.appendOp(a, op(g, "file.update", 1), "content", "accepted");
    const lost = store.appendOp(a, op(g, "file.update", 1, { content: "loser" }), "content", "conflict");
    expect(lost.version).toBe(2);
    expect(store.snapshotPage(a, "", 10, true).gids[0].conflicts).toHaveLength(1);
    expect(store.currentVersion(a, g, "content")).toBe(2);
    store.appendOp(a, op(g, "file.update", 2), "content", "accepted");
    expect(store.snapshotPage(a, "", 10, true).gids[0].conflicts).toHaveLength(0);
  });

  it("file.delete tombstones the gid and removes its other records", () => {
    const g = "3@aaaaaaaaaaaaaaaa";
    store.appendOp(a, op(g, "file.create", null), "content", "accepted");
    store.appendOp(a, op(g, "tag.set", 0), "metadata", "accepted");
    const del = store.appendOp(a, op(g, "file.delete", 1), "content", "accepted");
    expect(del.version).toBe(2);
    const recs = store.snapshotPage(a, "", 10, true).gids[0].records;
    expect(recs.map((r) => [r.kind, r.deleted])).toEqual([["file.delete", true]]);
  });

  it("opsSince, snapshots and versions never return rows from another brain", () => {
    const g = "4@aaaaaaaaaaaaaaaa";
    store.appendOp(a, op(g, "file.create", null), "content", "accepted");
    expect(store.opsSince(b, 0, 10)).toEqual([]);
    expect(store.snapshotPage(b, "", 10, true).gids).toEqual([]);
    expect(store.currentVersion(b, g, "content")).toBe(0);
    expect(store.latestSeq(b)).toBe(0);
    expect(store.hasMachine(b, "aaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("snapshotPage emits a gid's rows in seq order (create before move) and pages by gid", () => {
    const g = "5@aaaaaaaaaaaaaaaa";
    store.appendOp(a, op(g, "file.create", null), "content", "accepted");
    store.appendOp(a, op(g, "file.move", 1), "content", "accepted");
    store.appendOp(a, op("6@aaaaaaaaaaaaaaaa", "file.create", null), "content", "accepted");
    const p1 = store.snapshotPage(a, "", 1, true);
    expect(p1.gids[0].records.map((r) => r.kind)).toEqual(["file.create", "file.move"]);
    expect(p1.next).toBe(g);
    expect(store.snapshotPage(a, p1.next!, 1, true).gids[0].gid).toBe("6@aaaaaaaaaaaaaaaa");
  });

  it("opsSince reports gid_version, the accepted count right after each op", () => {
    const g = "7@aaaaaaaaaaaaaaaa";
    store.appendOp(a, op(g, "file.create", null), "content", "accepted");
    store.appendOp(a, op(g, "file.update", 1), "content", "accepted");
    expect(store.opsSince(a, 0, 10).map((r) => r.gid_version)).toEqual([1, 2]);
    expect(store.opsSince(a, 1, 10).map((r) => r.gid_version)).toEqual([2]);
  });
});
