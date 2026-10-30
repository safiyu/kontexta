import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { enqueueOp } from "../../src/storage/outbox.js";
import { countUnresolvedConflicts, listConflicts, resolveConflict } from "../../src/storage/conflicts.js";
import { createHost, createMachine, connect, sync, use, disposeMachine, writeKb, HOST_URL, type Machine, type Host } from "./helpers/brainhost.js";
import { joinBrain } from "../../src/storage/brain.js";
import { generateShareId, formatShareId } from "../../src/storage/shareid.js";

const A = "a1b2c3d4e5f60718";
const B = "0f1e2d3c4b5a6978";
const C = "c3c3c3c3c3c3c3c3";
const X = "d4d4d4d4d4d4d4d4";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const machines: Machine[] = [];
let host: Host;
const mk = (id: string, label: string) => {
  const m = createMachine(id, label);
  machines.push(m);
  return m;
};
afterEach(() => {
  host?.close();
  machines.splice(0).forEach(disposeMachine);
});

function seedFile(m: Machine, rel: string, content: string, n: number): string {
  const path = writeKb(m, rel, content);
  const gid = `${n}@${m.id}`;
  const id = Number(m.db.prepare("INSERT INTO files (path, title, storage_type, content_hash, gid) VALUES (?, ?, 'local', ?, ?)").run(path, rel, sha(content), gid).lastInsertRowid);
  m.db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(id, rel, content);
  enqueueOp(m.db, {
    gid, kind: "file.create", origin: m.id, base_version: null,
    payload: { path, rel_path: `knowledge/${rel}`, title: rel, content, content_hash: sha(content), storage_type: "local", tags: [] },
    created_at: Date.now(),
  });
  return path;
}

/** Edit a synced file the way the watcher would: write it, update the row, enqueue file.update. */
function editFile(m: Machine, gid: string, rel: string, content: string, createdAt = Date.now()): void {
  const path = writeKb(m, rel, content);
  const row = m.db.prepare("SELECT id FROM files WHERE gid = ?").get(gid) as { id: number };
  m.db.prepare("UPDATE files SET content_hash = ? WHERE id = ?").run(sha(content), row.id);
  m.db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(row.id);
  m.db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(row.id, rel, content);
  enqueueOp(m.db, {
    gid, kind: "file.update", origin: m.id, base_version: 0,
    payload: { path, rel_path: `knowledge/${rel}`, title: rel, content, content_hash: sha(content) },
    created_at: createdAt,
  });
}

const read = (m: Machine, rel: string): string => readFileSync(join(m.dir, "knowledge", rel), "utf8");

describe("brains end to end", () => {
  it("three machines in one brain: a concurrent edit leaves everyone with their own file and a conflict, and resolving converges", async () => {
    host = createHost();
    const a = mk(A, "a");
    const b = mk(B, "b");
    const c = mk(C, "c");
    use(a);
    seedFile(a, "plan.md", "v1", 1);
    const share = await connect(a, host, { create: true });
    await connect(b, host, { shareId: share });
    await connect(c, host, { shareId: share });
    expect([read(b, "plan.md"), read(c, "plan.md")]).toEqual(["v1", "v1"]);

    const gid = `1@${A}`;
    editFile(a, gid, "plan.md", "A edit");
    editFile(b, gid, "plan.md", "B edit");
    await sync(a, host); // A wins the race
    await sync(b, host); // B's push is flagged conflict
    await sync(c, host);
    await sync(a, host);
    await sync(b, host);

    expect(read(a, "plan.md")).toBe("A edit");
    expect(read(b, "plan.md")).toBe("B edit");
    expect(read(c, "plan.md")).toBe("A edit");
    for (const m of [a, b, c]) {
      use(m);
      expect(countUnresolvedConflicts(m.db), `conflicts on ${m.label}`).toBe(1);
    }

    // Everyone settles on A's text: B takes the server's version, A and C keep theirs.
    use(b);
    await resolveConflict(gid, { strategy: "keep-server" }, b.db);
    use(a);
    await resolveConflict(gid, { strategy: "keep-mine" }, a.db);
    use(c);
    await resolveConflict(gid, { strategy: "keep-mine" }, c.db);
    for (let i = 0; i < 2; i++) for (const m of [a, b, c]) await sync(m, host);

    expect([read(a, "plan.md"), read(b, "plan.md"), read(c, "plan.md")]).toEqual(["A edit", "A edit", "A edit"]);
  });

  it("two brains on one server never see each other's data", async () => {
    host = createHost();
    const a = mk(A, "a");
    const x = mk(X, "x");
    use(a);
    seedFile(a, "private.md", "brain one only", 1);
    await connect(a, host, { create: true });
    await connect(x, host, { create: true });
    await sync(x, host);
    use(x);
    expect(existsSync(join(x.dir, "knowledge", "private.md"))).toBe(false);
    expect((x.db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n).toBe(0);
    const perBrain = host.db.prepare("SELECT brain_id, COUNT(*) AS n FROM ops GROUP BY brain_id").all() as Array<{ brain_id: number; n: number }>;
    expect(perBrain).toEqual([{ brain_id: 1, n: 1 }]);
  });

  it("server order wins over client clocks: the first push is canonical even when its clock is far behind", async () => {
    host = createHost();
    const a = mk(A, "a");
    const b = mk(B, "b");
    const c = mk(C, "c");
    use(a);
    seedFile(a, "clock.md", "v1", 1);
    const share = await connect(a, host, { create: true });
    await connect(b, host, { shareId: share });
    const gid = `1@${A}`;
    const day = 86_400_000;
    editFile(a, gid, "clock.md", "A, clock a day ahead", Date.now() + day);
    editFile(b, gid, "clock.md", "B, clock a day behind", Date.now() - day);
    await sync(b, host); // B reaches the server first
    await sync(a, host); // A's newer clock does not matter: it is flagged conflict
    await connect(c, host, { shareId: share });
    expect(read(c, "clock.md")).toBe("B, clock a day behind");
    use(a);
    expect(read(a, "clock.md")).toBe("A, clock a day ahead");
    expect(countUnresolvedConflicts(a.db)).toBe(1);
  });

  it("a machine that lost its token rejoins with the share id and keeps syncing", async () => {
    host = createHost();
    const a = mk(A, "a");
    use(a);
    seedFile(a, "keep.md", "kept", 1);
    const share = await connect(a, host, { create: true });
    use(a);
    const again = await joinBrain(a.db, HOST_URL, { shareId: share, hostname: "a", fetchImpl: host.fetch });
    expect(again.sameBrainAsBefore).toBe(true);
    expect(host.db.prepare("SELECT COUNT(*) AS n FROM brains").get()).toEqual({ n: 1 });
    await sync(a, host);
    expect(listConflicts(a.db, { status: "all" })).toEqual([]);
    void generateShareId; void formatShareId;
  });
});
