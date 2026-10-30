import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { knownGidVersion, knownGidVersions, recordGidVersion, bumpPendingBases } from "../../src/storage/versions.js";
import { enqueueOp } from "../../src/storage/outbox.js";

const MID = "aaaaaaaaaaaaaaaa";

describe("gid versions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kxta-versions-"));
    createDatabase(join(dir, "t.db"));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("knownGidVersions returns the stored version and omits unknown gids", () => {
    const db = getDatabase();
    recordGidVersion(db, `1@${MID}`, 3);
    const m = knownGidVersions(db, [`1@${MID}`, `2@${MID}`]);
    expect(m.get(`1@${MID}`)).toBe(3);
    expect(m.has(`2@${MID}`)).toBe(false);
    expect(knownGidVersion(db, `2@${MID}`)).toBe(0);
  });

  it("recordGidVersion never lowers a version", () => {
    const db = getDatabase();
    recordGidVersion(db, `1@${MID}`, 5);
    recordGidVersion(db, `1@${MID}`, 2);
    expect(knownGidVersion(db, `1@${MID}`)).toBe(5);
  });

  it("enqueueOp stores the known version for a mutation and keeps null for a create", () => {
    const db = getDatabase();
    const gid = `7@${MID}`;
    recordGidVersion(db, gid, 3);
    const op = (kind: "file.update" | "file.create", base: number | null) => ({
      gid, kind, origin: MID, base_version: base, payload: {}, created_at: Date.now(),
    });
    const u = enqueueOp(db, op("file.update", 0));
    const c = enqueueOp(db, op("file.create", null));
    const row = (id: number) => (db.prepare("SELECT base_version FROM outbox WHERE id = ?").get(id) as { base_version: number | null }).base_version;
    expect(row(u)).toBe(3);
    expect(row(c)).toBeNull();
  });

  it("bumpPendingBases raises only later pending ops of the same gid", () => {
    const db = getDatabase();
    const gid = `8@${MID}`;
    const mk = (g: string) => enqueueOp(db, { gid: g, kind: "file.update", origin: MID, base_version: 0, payload: {}, created_at: Date.now() });
    const a = mk(gid), b = mk(gid), other = mk(`9@${MID}`);
    bumpPendingBases(db, gid, a);
    const row = (id: number) => (db.prepare("SELECT base_version FROM outbox WHERE id = ?").get(id) as { base_version: number }).base_version;
    expect([row(a), row(b), row(other)]).toEqual([0, 1, 0]);
  });
});
