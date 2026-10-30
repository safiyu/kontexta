import { describe, it, expect } from "vitest";
import {
  OP_KINDS,
  type Op,
  type OpKind,
  parseOp,
  serializeOp,
  deserializeOp,
} from "../../src/storage/op.js";

// TDD contract for the Phase 3 operation codec (src/storage/op.ts, created in
// the following milestone). It runs RED today because that module is absent:
// the import below fails to resolve, so the whole file is an error. It turns
// GREEN once op.ts lands and satisfies this contract:
//
//   op.ts -> OP_KINDS (readonly OpKind[]), type Op, type OpKind,
//           parseOp(raw: unknown): Op | null,
//           serializeOp(op: Op): string,
//           deserializeOp(json: string): Op | null
//
// The codec is the wire boundary for the outbox: an Op is serialized to a JSON
// string to be stored in the local outbox and shipped to the sync server, and
// is deserialized + re-validated on the receiving side. It must therefore be
// DETERMINISTIC (the same logical op always yields the same bytes — this is
// what makes ops hashable for de-duplication) and STRICT (an untrusted value
// from the wire that is not a well-formed Op must be rejected, not silently
// coerced).
//
// Invariants pinned here (implementation freedom is left for the rest):
//   * Op schema (spec 1.3): gid, kind, origin, base_version (number | null),
//     payload (JSON-serializable), created_at (number). Snake_case field names
//     match the codebase's SQLite convention.
//   * OpKind is the closed set of mutation kinds named in spec 1.3. The
//     `calendar.*` family is instantiated as the three calendar tables
//     (entity/event/link) in upsert form.
//   * parseOp is pure and synchronous: it returns null (or throws) on any
//     malformed input — never a partially-coerced object. We accept EITHER
//     mechanism, matching parseGid (see identity.test.ts).
//   * serializeOp is canonical: output depends only on the op's logical
//     content, not on key insertion order.

/** Spec-example machine id (16-hex), reused across the pure codec tests. */
const MID = "4f9e1a8b3c7d2e0f";
/** A well-formed GID: <localId>@<machineId> (see identity/gid.ts). */
const GID = "104@4f9e1a8b3c7d2e0f";

/** Every mutation kind named in spec 1.3. */
const SPEC_KINDS: readonly OpKind[] = [
  "file.create",
  "file.update",
  "file.delete",
  "file.move",
  "folder.create",
  "folder.delete",
  "tag.set",
  "favorite.set",
  "project.register",
  "project.unregister",
  "calendar.entity.upsert",
  "calendar.event.upsert",
  "calendar.link.upsert",
  "journal.meta.upsert",
];

/** A fully well-formed Op; `overrides` lets a case perturb a single field. */
function validOp(overrides: Record<string, unknown> = {}): Op {
  return {
    gid: GID,
    kind: "file.update",
    origin: MID,
    base_version: 3,
    payload: { path: "/kb/a/f1.md", content: "hello world" },
    created_at: 1_700_000_000_000,
    ...overrides,
  } as unknown as Op;
}

/**
 * A codec "rejects" input iff it returns null/undefined OR throws. The
 * contract is "not parsed into a plausible Op", not the specific mechanism —
 * the same convention identity.test.ts uses for parseGid.
 */
function isRejected(fn: () => unknown): boolean {
  try {
    return fn() == null;
  } catch {
    return true;
  }
}

describe("Op codec (src/storage/op.ts)", () => {
  describe("OP_KINDS (canonical mutation-kind set)", () => {
    it("exposes a non-empty, unique, string-valued set", () => {
      expect(Array.isArray(OP_KINDS)).toBe(true);
      expect(OP_KINDS.length, "OP_KINDS must not be empty").toBeGreaterThan(0);
      for (const k of OP_KINDS) {
        expect(typeof k, `every kind must be a string (got ${typeof k})`).toBe("string");
      }
      expect(new Set(OP_KINDS).size, "OP_KINDS must have no duplicates").toBe(OP_KINDS.length);
    });

    it("covers every mutation kind named in the spec", () => {
      for (const k of SPEC_KINDS) {
        expect(OP_KINDS, `OP_KINDS must include ${k}`).toContain(k);
      }
    });
  });

  describe("parseOp (schema validation)", () => {
    describe("accepts", () => {
      it("accepts a well-formed op and preserves every field exactly", () => {
        const op = validOp();
        const parsed = parseOp(op);
        expect(parsed, "a valid op must parse to non-null").not.toBeNull();
        expect(parsed).toEqual(op);
      });

      it("accepts base_version: null (create ops carry no base version)", () => {
        const parsed = parseOp(validOp({ kind: "file.create", base_version: null }));
        expect(parsed, "base_version:null must be accepted").not.toBeNull();
        expect((parsed as Op).base_version, "null base_version must be preserved").toBeNull();
      });

      it("accepts every spec mutation kind", () => {
        for (const k of SPEC_KINDS) {
          expect(parseOp(validOp({ kind: k })), `kind ${k} must be accepted`).not.toBeNull();
        }
      });

      it("accepts null and JSON-primitive payloads", () => {
        for (const p of [null, "a string", 42, false, [1, 2, { a: 3 }], { a: { b: [true] } }]) {
          const parsed = parseOp(validOp({ payload: p }));
          expect(parsed, `payload ${JSON.stringify(p)} must be accepted`).not.toBeNull();
          expect((parsed as Op).payload, "payload must round-trip through parse").toEqual(p);
        }
      });
    });

    describe("rejects", () => {
      it("rejects non-object inputs (null, primitives, arrays)", () => {
        for (const bad of [null, undefined, "op", 5, true, ["file.update"]]) {
          expect(
            isRejected(() => parseOp(bad)),
            `parseOp(${JSON.stringify(bad)}) must be rejected`,
          ).toBe(true);
        }
      });

      it("rejects malformed gids (empty / no separator / empty parts)", () => {
        for (const gid of ["", "no-at-sign", "104@", "@mid"]) {
          expect(
            isRejected(() => parseOp(validOp({ gid }))),
            `gid ${JSON.stringify(gid)} must be rejected`,
          ).toBe(true);
        }
      });

      it("rejects unknown or mistyped kinds", () => {
        for (const kind of ["file.upsert", "File.Create", "favorite.add", "no-dot-here", ""]) {
          expect(
            isRejected(() => parseOp(validOp({ kind }))),
            `kind ${JSON.stringify(kind)} must be rejected`,
          ).toBe(true);
        }
      });

      it("rejects a missing or non-string origin", () => {
        for (const origin of ["", 123]) {
          expect(
            isRejected(() => parseOp(validOp({ origin }))),
            `origin ${JSON.stringify(origin)} must be rejected`,
          ).toBe(true);
        }
      });

      it("rejects base_version that is not a non-negative integer (or null)", () => {
        for (const base_version of ["3", -1, 1.5, Number.NaN, {}, true]) {
          expect(
            isRejected(() => parseOp(validOp({ base_version }))),
            `base_version ${JSON.stringify(base_version)} must be rejected`,
          ).toBe(true);
        }
      });

      it("rejects a created_at that is not a finite number", () => {
        for (const created_at of ["now", Number.NaN, {}, true]) {
          expect(
            isRejected(() => parseOp(validOp({ created_at }))),
            `created_at ${JSON.stringify(created_at)} must be rejected`,
          ).toBe(true);
        }
      });

      it("rejects a payload that is not JSON-serializable (function / symbol)", () => {
        for (const payload of [() => 1, Symbol("s")]) {
          expect(
            isRejected(() => parseOp(validOp({ payload }))),
            `non-JSON-serializable payload must be rejected`,
          ).toBe(true);
        }
      });
    });
  });

  describe("serializeOp (canonical wire encoding)", () => {
    it("produces a string that is valid JSON", () => {
      const s = serializeOp(validOp());
      expect(typeof s, "serializeOp must return a string").toBe("string");
      expect(() => JSON.parse(s), "serializeOp output must be valid JSON").not.toThrow();
    });

    it("is canonical: byte-identical regardless of key insertion order", () => {
      const a: Op = validOp();
      const b = {
        created_at: a.created_at,
        payload: a.payload,
        base_version: a.base_version,
        origin: a.origin,
        kind: a.kind,
        gid: a.gid,
      } as unknown as Op; // same fields, reversed key order
      expect(serializeOp(a), "serialization must be key-order independent").toBe(serializeOp(b));
    });

    it("round-trips a complex, unicode-bearing payload", () => {
      const payload = {
        path: "/kb/note.md",
        title: "Café ☕ ünïcode — 日本語",
        tags: ["a", "b", "c"],
        nested: { deep: { list: [1, 2, 3], flag: true, nothing: null } },
      };
      const op = validOp({ kind: "file.create", base_version: null, payload });
      const back = deserializeOp(serializeOp(op)) as Op;
      expect(back, "round-trip must not lose the op").not.toBeNull();
      expect(back.payload, "nested unicode payload must survive serialize/deserialize").toEqual(payload);
    });
  });

  describe("deserializeOp (JSON string -> validated Op)", () => {
    it("rejects malformed JSON", () => {
      for (const bad of ["not json", "{", "]", ""]) {
        expect(
          isRejected(() => deserializeOp(bad)),
          `deserializeOp(${JSON.stringify(bad)}) must be rejected`,
        ).toBe(true);
      }
    });

    it("rejects JSON that parses but is not an Op", () => {
      for (const bad of ["42", '"a string"', "null", "true", "[1,2]"]) {
        expect(
          isRejected(() => deserializeOp(bad)),
          `deserializeOp(${bad}) must be rejected (valid JSON, not an Op)`,
        ).toBe(true);
      }
    });

    it("validates the decoded value (a well-shaped object with a bad kind is rejected)", () => {
      const obj = { gid: GID, kind: "bogus.kind", origin: MID, base_version: 3, payload: {}, created_at: 1 };
      expect(
        isRejected(() => deserializeOp(JSON.stringify(obj))),
        "a JSON object whose kind is not in OP_KINDS must be rejected",
      ).toBe(true);
    });

    it("rejects a JSON object missing a required field", () => {
      const { gid: _gid, ...noGid } = validOp();
      expect(
        isRejected(() => deserializeOp(JSON.stringify(noGid))),
        "an op missing its gid must be rejected",
      ).toBe(true);
    });
  });
});

import { kindFamily, parseOp as parseOpForFamily } from "../../src/storage/op.js";
describe("kindFamily and retired tag kinds", () => {
  it("groups file.* as content and tag.set/favorite.set as metadata", () => {
    expect(kindFamily("file.update")).toBe("content");
    expect(kindFamily("file.move")).toBe("content");
    expect(kindFamily("tag.set")).toBe("metadata");
    expect(kindFamily("favorite.set")).toBe("metadata");
    expect(kindFamily("calendar.event.upsert")).toBe("calendar.event.upsert");
    expect(kindFamily("journal.meta.upsert")).toBe("journal");
  });
  it("parseOp rejects the retired tag.add and tag.remove kinds", () => {
    for (const kind of ["tag.add", "tag.remove"]) {
      expect(parseOpForFamily({ gid: "1@aaaaaaaaaaaaaaaa", kind, origin: "aaaaaaaaaaaaaaaa", base_version: 0, payload: {}, created_at: 1 })).toBeNull();
    }
  });
});
