import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../src/db/index.js";
import { getSetting } from "../src/metadata/settings.js";
import { formatGid, parseGid, isLocalGid } from "../src/identity/gid.js";
import {
  getMachineId,
  getMachineLabel,
  setMachineLabel,
  recordClientConnected,
  listClients,
} from "../src/identity/machine.js";

// TDD contract for the Phase 2 identity module (src/identity/gid.ts +
// machine.ts, created in the following milestones). It runs RED today because
// those modules do not exist yet, so this file fails to resolve its imports.
// It turns GREEN once both modules land and satisfy this contract:
//
//   gid.ts     -> formatGid(localId, machineId), parseGid(gid), isLocalGid(gid)
//   machine.ts -> getMachineId, getMachineLabel, setMachineLabel,
//                 recordClientConnected(hostname), listClients()
//
// Invariants pinned here (the rest is left to implementation freedom):
//   * gid format is `<localId>@<machineId>` (see spec example 104@4f9e1a8b3c7d2e0f).
//   * machine_id is the stable 16-hex value seeded into settings by migration 013.
//   * clients is keyed on machine_id (one row per machine); migration 013 seeds
//     `settings` but NOT `clients`, so the local row appears only after
//     recordClientConnected(hostname) is called.
//   * listClients returns raw client rows (snake_case columns) to match the
//     codebase convention (listTags/listProjects cast raw rows directly).

const HEX16 = /^[0-9a-fA-F]{16}$/;
// Spec-example machine id, used for pure (DB-free) codec tests.
const MID = "4f9e1a8b3c7d2e0f";

/** A 16-hex id guaranteed different from `mid` (for the "other machine" cases). */
function otherHex16(mid: string): string {
  return mid === "ffffffffffffffff" ? "0000000000000000" : "ffffffffffffffff";
}

/**
 * A GID codec must reject malformed input. We accept EITHER a null/undefined
 * return OR a throw — the contract is "not parsed into a plausible object",
 * not the specific rejection mechanism.
 */
function isParseRejected(gid: string): boolean {
  try {
    return parseGid(gid) == null;
  } catch {
    return true;
  }
}

describe("Identity: machine id + GID codec", () => {
  let testDir = "";
  const tempDbs: string[] = [];

  const mkDbPath = (): string => {
    if (!testDir) testDir = mkdtempSync(join(tmpdir(), "kontexta-identity-"));
    const p = join(testDir, `${tempDbs.length + 1}.db`);
    tempDbs.push(p);
    return p;
  };

  afterEach(() => {
    closeDatabase(); // clear the shared singleton (no-op if a pure test left none open)
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

  describe("GID codec (src/identity/gid.ts)", () => {
    describe("formatGid / parseGid (pure, no DB)", () => {
      it("formats <localId>@<machineId>", () => {
        expect(formatGid(104, MID)).toBe("104@4f9e1a8b3c7d2e0f");
        expect(formatGid(1, "aabbccddeeff0011")).toBe("1@aabbccddeeff0011");
      });

      it("parses a well-formed gid back to its parts", () => {
        const r = parseGid("104@4f9e1a8b3c7d2e0f");
        expect(r, "valid gid must parse to an object").not.toBeNull();
        const parts = r as { localId: number; machineId: string };
        expect(Number(parts.localId)).toBe(104);
        expect(parts.machineId).toBe(MID);
      });

      it("round-trips formatGid -> parseGid across pk values", () => {
        for (const localId of [0, 1, 7, 104, 999_999]) {
          const r = parseGid(formatGid(localId, MID));
          expect(r, `round-trip failed for localId=${localId}`).not.toBeNull();
          const parts = r as { localId: number; machineId: string };
          expect(Number(parts.localId)).toBe(localId);
          expect(parts.machineId).toBe(MID);
        }
      });

      it("rejects malformed gids (no separator / empty parts)", () => {
        for (const bad of ["", "no-at-sign", "104 4f9e1a8b3c7d2e0f", "@mid", "104@"]) {
          expect(
            isParseRejected(bad),
            `parseGid(${JSON.stringify(bad)}) must be rejected`,
          ).toBe(true);
        }
      });
    });

    describe("isLocalGid (DB-backed, resolves the local machine_id)", () => {
      it("true for the local machine, false for another, false for garbage", () => {
        createDatabase(mkDbPath());
        const mid = getSetting("machine_id");
        expect(mid, "settings.machine_id must be seeded by migration 013").toBeTruthy();
        expect(HEX16.test(mid!)).toBe(true);

        expect(isLocalGid(formatGid(104, mid!))).toBe(true); // local
        expect(isLocalGid(formatGid(1, otherHex16(mid!)))).toBe(false); // foreign
        // isLocalGid is a predicate: malformed input must yield false, not throw.
        expect(isLocalGid("not-a-gid")).toBe(false);
        expect(isLocalGid("")).toBe(false);
      });
    });
  });

  describe("machine identity (src/identity/machine.ts, DB-backed)", () => {
    it("getMachineId returns a stable 16-hex id sourced from settings", () => {
      createDatabase(mkDbPath());
      const a = getMachineId();
      const b = getMachineId();
      expect(a, "getMachineId must be non-empty").toBeTruthy();
      expect(a, "getMachineId must be stable across calls").toBe(b);
      expect(HEX16.test(a!), `getMachineId must be 16 hex (got ${a})`).toBe(true);
      expect(a, "getMachineId must read settings.machine_id").toBe(getSetting("machine_id"));
    });

    it("setMachineLabel persists; getMachineLabel round-trips", () => {
      createDatabase(mkDbPath());
      // Initial label is seeded by migration 013 (may be empty) — just ensure the
      // getter is total. The behavioral contract is the set/get round-trip below.
      const initial = getMachineLabel();
      expect(initial === null || typeof initial === "string").toBe(true);

      setMachineLabel("my-laptop");
      expect(getMachineLabel()).toBe("my-laptop");
      expect(getSetting("machine_label"), "label must persist to settings").toBe("my-laptop");
    });

    it("recordClientConnected upserts the local machine into clients (one row, keyed by machine_id)", () => {
      const db = createDatabase(mkDbPath());
      const mid = getMachineId()!;
      const rowsForLocal = () =>
        (db.prepare("SELECT * FROM clients WHERE machine_id = ?").all(mid) as any[]);

      recordClientConnected("host-a");
      expect(rowsForLocal().length, "one row for the local machine after connect").toBe(1);
      expect(rowsForLocal()[0].hostname).toBe("host-a");

      // Same host again -> still one row (idempotent upsert).
      recordClientConnected("host-a");
      expect(rowsForLocal().length).toBe(1);

      // Different host -> updates the single row; must NOT create a duplicate
      // (clients is keyed on machine_id, not hostname).
      recordClientConnected("host-b");
      const rows = rowsForLocal();
      expect(rows.length, "must not duplicate on hostname change").toBe(1);
      expect(rows[0].hostname, "hostname reflects the most recent connection").toBe("host-b");
    });

    it("listClients returns recorded clients incl. the local machine and foreign machines", () => {
      const db = createDatabase(mkDbPath());
      const mid = getMachineId()!;
      expect(Array.isArray(listClients()), "listClients must return an array").toBe(true);

      recordClientConnected("host-a");
      // A second machine that connected from elsewhere. The API only records the
      // local machine, so we seed a foreign client row directly to exercise listing.
      const foreign = otherHex16(mid);
      db.prepare(
        "INSERT INTO clients (machine_id, hostname, first_seen_at, last_seen_at) " +
          "VALUES (?, ?, datetime('now'), datetime('now'))",
      ).run(foreign, "other-box");

      const clients = listClients() as any[];
      expect(clients.length, "both local and foreign clients must be listed").toBe(2);

      const local = clients.find((c) => c.machine_id === mid);
      expect(local, "local machine must be listed").toBeTruthy();
      expect(local.hostname).toBe("host-a");

      const foreignRec = clients.find((c) => c.machine_id === foreign);
      expect(foreignRec, "foreign client must be listed").toBeTruthy();
      expect(foreignRec.hostname).toBe("other-box");
    });
  });
});
