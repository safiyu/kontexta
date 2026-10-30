import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { enqueueOp } from "../../src/storage/outbox.js";
import { settingUpsert, settingValue } from "../../src/storage/brain.js";
import { bootstrapIfNeeded } from "../../src/storage/bootstrap.js";
import { countUnresolvedConflicts } from "../../src/storage/conflicts.js";
import { createHost, createMachine, connect, sync, use, disposeMachine, writeKb, type Machine, type Host } from "./helpers/relayhost.js";

const A = "a1b2c3d4e5f60718";
const B = "0f1e2d3c4b5a6978";
const C = "c3c3c3c3c3c3c3c3";
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

/** Seed a local KB file the way the watcher would: files row, fts row, and the create op in the outbox. */
function seedFile(m: Machine, rel: string, content: string, n: number): string {
  const path = writeKb(m, rel, content);
  const gid = `${n}@${m.id}`;
  const id = Number(
    m.db
      .prepare("INSERT INTO files (path, title, storage_type, content_hash, gid) VALUES (?, ?, 'local', ?, ?)")
      .run(path, rel, sha(content), gid).lastInsertRowid,
  );
  m.db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(id, rel, content);
  enqueueOp(m.db, {
    gid,
    kind: "file.create",
    origin: m.id,
    base_version: null,
    payload: { path, rel_path: `knowledge/${rel}`, title: rel, content, content_hash: sha(content), storage_type: "local", tags: [] },
    created_at: Date.now(),
  });
  return path;
}

describe("bootstrap", () => {
  it("an empty machine ends with the canonical files, the conflict copies and the conflict rows", async () => {
    host = createHost();
    const a = mk(A, "laptop-a");
    const b = mk(B, "laptop-b");
    use(a);
    const pathA = seedFile(a, "plan.md", "v1", 1);
    const share = await connect(a, host, { create: true });
    // B joins, edits offline-style on top of v1, and loses a race with A's later edit.
    await connect(b, host, { shareId: share });
    enqueueOp(a.db, { gid: `1@${A}`, kind: "file.update", origin: A, base_version: 0, payload: { path: pathA, rel_path: "knowledge/plan.md", title: "plan.md", content: "A edit", content_hash: sha("A edit") }, created_at: Date.now() });
    enqueueOp(b.db, { gid: `1@${A}`, kind: "file.update", origin: B, base_version: 0, payload: { path: join(b.dir, "knowledge", "plan.md"), rel_path: "knowledge/plan.md", title: "plan.md", content: "B edit", content_hash: sha("B edit") }, created_at: Date.now() });
    await sync(a, host); // A wins
    await sync(b, host); // B's push is flagged conflict on the server

    const c = mk(C, "replacement");
    await connect(c, host, { shareId: share });
    use(c);
    expect(readFileSync(join(c.dir, "knowledge", "plan.md"), "utf8")).toBe("A edit");
    expect(countUnresolvedConflicts(c.db)).toBe(1);
    const copies = c.db.prepare("SELECT conflict_path FROM conflicts WHERE status = 'unresolved'").all() as Array<{ conflict_path: string }>;
    expect(existsSync(copies[0].conflict_path)).toBe(true);
    expect(readFileSync(copies[0].conflict_path, "utf8")).toBe("B edit");
  });

  it("a machine with content keeps equal files, forks differing ones, and pushes its own history afterwards", async () => {
    host = createHost();
    const a = mk(A, "laptop-a");
    seedFile(a, "same.md", "shared", 1);
    seedFile(a, "differs.md", "from A", 2);
    const share = await connect(a, host, { create: true });

    const b = mk(B, "laptop-b");
    use(b);
    seedFile(b, "own.md", "only on B", 3);
    // B holds the same gids A created, with different content for one of them.
    for (const [rel, content, n] of [["same.md", "shared", 1], ["differs.md", "B version", 2]] as const) {
      const path = writeKb(b, rel, content);
      const id = Number(b.db.prepare("INSERT INTO files (path, title, storage_type, content_hash, gid) VALUES (?, ?, 'local', ?, ?)").run(path, rel, sha(content), `${n}@${A}`).lastInsertRowid);
      b.db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(id, rel, content);
    }
    await connect(b, host, { shareId: share });

    use(b);
    expect(readFileSync(join(b.dir, "knowledge", "differs.md"), "utf8")).toBe("B version");
    expect(readFileSync(join(b.dir, "knowledge", "same.md"), "utf8")).toBe("shared");
    expect(countUnresolvedConflicts(b.db)).toBe(1);
    // B's own file reached the brain, so A sees it after a sync.
    await sync(a, host);
    use(a);
    expect(readFileSync(join(a.dir, "knowledge", "own.md"), "utf8")).toBe("only on B");
  });

  it("an interrupted bootstrap resumes from the last gid", async () => {
    host = createHost();
    const a = mk(A, "laptop-a");
    seedFile(a, "one.md", "1", 1);
    seedFile(a, "two.md", "2", 2);
    const share = await connect(a, host, { create: true });
    const b = mk(B, "laptop-b");
    use(b);
    const failing = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("after=1%40")) throw new Error("network down");
      return host.fetch(input, init);
    }) as typeof fetch;
    const { joinBrain } = await import("../../src/storage/brain.js");
    await joinBrain(b.db, "http://brain.test", { shareId: share, hostname: "b", fetchImpl: host.fetch });
    // Page size 1 so the first gid completes, then the second page fails.
    await expect(bootstrapIfNeeded(b.db, { fetchImpl: failing, pageLimit: 1 })).rejects.toThrow(/network down/);
    expect(settingValue(b.db, "brain_bootstrap_after")).toBe(`1@${A}`);
    expect(settingValue(b.db, "brain_bootstrap_pending")).toBe("1");
    const result = await bootstrapIfNeeded(b.db, { fetchImpl: host.fetch, pageLimit: 1 });
    expect(result).toMatchObject({ mode: "merge" });
    expect(existsSync(join(b.dir, "knowledge", "two.md"))).toBe(true);
    expect(settingValue(b.db, "brain_bootstrap_pending")).toBeNull();
    void settingUpsert;
  });

  it("does not fork a parked conflict whose content already matches the canonical file", async () => {
    host = createHost();
    const a = mk(A, "laptop-a");
    const b = mk(B, "laptop-b");
    use(a);
    const pathA = seedFile(a, "same.md", "v1", 1);
    const share = await connect(a, host, { create: true });
    await connect(b, host, { shareId: share });
    const gid = `1@${A}`;
    const upd = (m: Machine, content: string, p: string) =>
      enqueueOp(m.db, { gid, kind: "file.update", origin: m.id, base_version: 0, payload: { path: p, rel_path: "knowledge/same.md", title: "same.md", content, content_hash: sha(content) }, created_at: Date.now() });
    upd(a, "same text", pathA);
    upd(b, "same text", join(b.dir, "knowledge", "same.md"));
    await sync(a, host);
    await sync(b, host); // identical content flagged as a conflict on the server
    const c = mk(C, "replacement");
    await connect(c, host, { shareId: share });
    use(c);
    expect(readFileSync(join(c.dir, "knowledge", "same.md"), "utf8")).toBe("same text");
    expect(countUnresolvedConflicts(c.db)).toBe(0);
  });

  it("ops that land while paging are pulled afterwards instead of being skipped by the cursor", async () => {
    host = createHost();
    const a = mk(A, "laptop-a");
    seedFile(a, "one.md", "1", 1);
    seedFile(a, "two.md", "2", 2);
    const share = await connect(a, host, { create: true });
    const b = mk(B, "laptop-b");
    use(b);
    const { joinBrain } = await import("../../src/storage/brain.js");
    await joinBrain(b.db, "http://brain.test", { shareId: share, hostname: "b", fetchImpl: host.fetch });
    let injected = false;
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await host.fetch(input, init);
      if (!injected && String(input).includes("/brains/snapshot")) {
        injected = true;
        // A lands an edit to the gid on page 1 right after B fetched the first page.
        const path = join(a.dir, "knowledge", "one.md");
        enqueueOp(a.db, { gid: `1@${A}`, kind: "file.update", origin: A, base_version: 0, payload: { path, rel_path: "knowledge/one.md", title: "one.md", content: "edited mid-bootstrap", content_hash: sha("edited mid-bootstrap") }, created_at: Date.now() });
        use(a);
        await sync(a, host);
        use(b);
      }
      return res;
    }) as typeof fetch;
    await bootstrapIfNeeded(b.db, { fetchImpl: racing, pageLimit: 1 });
    await sync(b, host);
    expect(readFileSync(join(b.dir, "knowledge", "one.md"), "utf8")).toBe("edited mid-bootstrap");
  });
});

import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("bootstrap dependents", () => {
  it("applies a calendar event whose entity sorts after it in the snapshot", async () => {
    host = createHost();
    const a = mk(A, "laptop-a");
    // "12@..." sorts before "3@..." as a string, so the event is paged before its entity.
    enqueueOp(a.db, { gid: `3@${A}`, kind: "calendar.entity.upsert", origin: A, base_version: null, payload: { name: "Alice", deleted: false }, created_at: 1 });
    enqueueOp(a.db, {
      gid: `12@${A}`, kind: "calendar.event.upsert", origin: A, base_version: null,
      payload: { entity_gid: `3@${A}`, type: "meeting", title: "Sync", starts_at: "2026-10-15T14:00:00Z", ends_at: "2026-10-15T15:00:00Z", deleted: false },
      created_at: 2,
    });
    const share = await connect(a, host, { create: true });

    // The calendar repository writes through the process-wide database, so the joining machine uses it.
    const dir = mkdtempSync(join(tmpdir(), "kxta-dep-"));
    process.env.KONTEXTA_DATA_DIR = dir;
    const { resetDataDirCache } = await import("../../src/util/paths.js");
    resetDataDirCache();
    const db = createDatabase(join(dir, "b.db"));
    try {
      const machineId = (db.prepare("SELECT value FROM settings WHERE key = 'machine_id'").get() as { value: string }).value;
      const { joinBrain } = await import("../../src/storage/brain.js");
      await joinBrain(db, "http://brain.test", { shareId: share, hostname: "b", fetchImpl: host.fetch });
      expect(machineId).toBeTruthy();
      const result = await bootstrapIfNeeded(db, { fetchImpl: host.fetch, pageLimit: 1 });
      expect(result?.skipped).toBe(0);
      expect(db.prepare("SELECT gid FROM calendar_events").all()).toEqual([{ gid: `12@${A}` }]);
      expect(db.prepare("SELECT gid FROM calendar_entities").all()).toEqual([{ gid: `3@${A}` }]);
    } finally {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
