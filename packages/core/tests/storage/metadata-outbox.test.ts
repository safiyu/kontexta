/**
 * M55 — write-side outbox instrumentation for the metadata module.
 *
 * Pins the contract that the five metadata write routines in
 * src/metadata/index.ts each append exactly one outbound op to the outbox
 * (the matching OpKind), atomically with the write, and that echo suppression
 * (spec 1.4) makes the SAME routines skip the enqueue entirely when they are
 * reached while a remote op is being applied (inRemoteApply() === true).
 *
 * GID sourcing (spec 1.2): `file_tags` and `favorites` have no gid column, so
 * tag.add / tag.remove and favorite.set ops are keyed by the FILE's gid (the
 * record being mutated); `project.*` ops are keyed by the PROJECT's gid. Tags
 * are identified globally by NAME (machine-local integer ids are not meaningful
 * across machines).
 *
 * This is the enqueue side only. The apply side (routing each op.kind back
 * into these routines inside the remote-apply scope) is M58 — not covered here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { createFile } from "../../src/files/index.js";
import {
  addTags,
  removeTags,
  setFavorite,
  registerProject,
  unregisterProject,
} from "../../src/metadata/index.js";
import { pendingOps, pendingCount } from "../../src/storage/outbox.js";
import { runInApplyScope, inRemoteApply } from "../../src/storage/apply.js";
import { getMachineId } from "../../src/identity/machine.js";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-meta-outbox-"));
const dbPath = join(TEST_DATA_DIR, "test.db");
const dataDir = join(TEST_DATA_DIR, "data");

function pending() {
  return pendingOps(getDatabase());
}

function findOp(kind: string) {
  return pending().find((o) => o.op.kind === kind);
}

async function makeFile(title: string, content: string) {
  return createFile({
    title,
    content,
    destination: "knowledge",
    folder: "knowledge",
    dataDir,
  });
}

/** The tag row id for a tag name (null if absent). */
function tagId(name: string): number | null {
  const row = getDatabase().prepare("SELECT id FROM tags WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

describe("metadata write-routine outbox instrumentation (M55)", () => {
  beforeEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mkdirSync(join(dataDir, "knowledge"), { recursive: true });
    createDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("addTags appends a tag.add op keyed by the file gid, carrying tag names", async () => {
    const file = await makeFile("Tagged", "body");
    expect(pendingCount(getDatabase())).toBe(1); // the file.create op

    addTags(file.id, ["alpha", "beta"]);

    const op = findOp("tag.add");
    expect(op).toBeDefined();
    expect(op!.op.gid).toBe(file.gid, "the op is keyed by the FILE's gid");
    expect(op!.op.origin).toBe(getMachineId());
    expect(op!.op.base_version).toBe(0);
    expect(op!.op.payload).toEqual({ file_id: file.id, tags: ["alpha", "beta"] });
    // Exactly one op for this mutation (plus the prior create).
    expect(pendingCount(getDatabase())).toBe(2);
  });

  it("addTags with an empty name list enqueues no tag op", async () => {
    const file = await makeFile("Empty", "body");
    addTags(file.id, []);
    expect(findOp("tag.add")).toBeUndefined();
    expect(pendingCount(getDatabase())).toBe(1);
  });

  it("removeTags appends a tag.remove op keyed by the file gid, carrying tag names", async () => {
    const file = await makeFile("Untagged", "body");
    addTags(file.id, ["alpha", "beta"]);
    expect(tagId("alpha")).not.toBeNull();

    removeTags(file.id, [tagId("alpha")!]);

    const op = findOp("tag.remove");
    expect(op).toBeDefined();
    expect(op!.op.gid).toBe(file.gid);
    // Carries the tag NAME (global identity), not the machine-local id.
    expect(op!.op.payload).toEqual({ file_id: file.id, tags: ["alpha"] });
  });

  it("removeTags of a tag not linked to the file enqueues no op", async () => {
    const file = await makeFile("NoRemove", "body");
    addTags(file.id, ["alpha"]);
    // A tag id that is not linked to this file (fresh tag).
    getDatabase().prepare("INSERT INTO tags (name) VALUES (?)").run("orphan");
    const orphanId = tagId("orphan")!;
    removeTags(file.id, [orphanId]);
    expect(findOp("tag.remove")).toBeUndefined();
  });

  it("setFavorite appends a favorite.set op keyed by the file gid, carrying the state", async () => {
    const file = await makeFile("Fav", "body");

    setFavorite(file.id, true);

    const op = findOp("favorite.set");
    expect(op).toBeDefined();
    expect(op!.op.gid).toBe(file.gid);
    expect(op!.op.payload).toEqual({ file_id: file.id, favorite: true });
    // The favorite row exists.
    const fav = getDatabase().prepare("SELECT 1 FROM favorites WHERE file_id = ?").get(file.id);
    expect(fav).toBeDefined();
  });

  it("registerProject appends a project.register op keyed by the project gid (null base_version)", async () => {
    const project = registerProject("My Test Project", "/path/to/project", "A test project");

    const op = findOp("project.register");
    expect(op).toBeDefined();
    const db = getDatabase();
    const row = db.prepare("SELECT gid FROM projects WHERE id = ?").get(project.id) as { gid: string | null };
    expect(op!.op.gid).toBe(row.gid, "the op is keyed by the PROJECT's gid");
    expect(op!.op.origin).toBe(getMachineId());
    expect(op!.op.base_version, "a registration has no prior version").toBeNull();
    expect(op!.op.payload).toMatchObject({
      name: "My Test Project",
      slug: "my-test-project",
      path: expect.any(String),
      description: "A test project",
    });
  });

  it("unregisterProject appends a project.unregister op keyed by the project gid", async () => {
    const project = registerProject("To Remove", "/path/to/remove");
    const db = getDatabase();
    const gidBefore = (db.prepare("SELECT gid FROM projects WHERE id = ?").get(project.id) as { gid: string | null }).gid;

    unregisterProject(project.id);

    const op = findOp("project.unregister");
    expect(op).toBeDefined();
    expect(op!.op.gid).toBe(gidBefore);
    expect(op!.op.payload).toMatchObject({ project_id: project.id, slug: "to-remove" });
    // The project row is gone.
    expect(db.prepare("SELECT id FROM projects WHERE id = ?").get(project.id)).toBeUndefined();
  });

  describe("echo suppression (spec 1.4): no enqueue while inRemoteApply()", () => {
    it("addTags / removeTags / setFavorite persist but enqueue no op inside a remote-apply scope", async () => {
      const file = await makeFile("RemoteMeta", "body");
      expect(pendingCount(getDatabase())).toBe(1); // the file.create op

      let sawRemote = false;
      await runInApplyScope(async () => {
        sawRemote = inRemoteApply();
        addTags(file.id, ["remote-tag"]);
        // setFavorite true then the op must not fire; assert the row exists.
        setFavorite(file.id, true);
        const rid = tagId("remote-tag")!;
        removeTags(file.id, [rid]);
      });

      expect(sawRemote, "inRemoteApply() must be true inside the scope").toBe(true);
      expect(inRemoteApply(), "the scope must not leak outside").toBe(false);
      // The mutations DID persist (local-first apply still mutates the store)…
      expect(tagId("remote-tag")).not.toBeNull();
      // …but NO metadata op was enqueued (the echo we must suppress).
      expect(pendingCount(getDatabase()), "no echo op may be enqueued").toBe(1);
      expect(pending().every((o) => o.op.kind === "file.create")).toBe(true);
    });

    it("registerProject / unregisterProject persist but enqueue no op inside a remote-apply scope", async () => {
      let sawRemote = false;
      let projectId: number;
      await runInApplyScope(async () => {
        sawRemote = inRemoteApply();
        const p = registerProject("Remote Project", "/path/to/remote-project");
        projectId = p.id;
        unregisterProject(p.id);
      });

      expect(sawRemote).toBe(true);
      const db = getDatabase();
      // The register-then-unregister netted to a deleted row…
      expect(db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)).toBeUndefined();
      // …and NEITHER the register NOR the unregister enqueued an op.
      expect(pendingCount(getDatabase()), "no project op may be enqueued").toBe(0);
    });
  });
});
