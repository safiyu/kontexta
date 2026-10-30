/**
 * Operation schema + wire codec — Phase 3 (storage/03-outbox).
 *
 * An `Op` is the unit of change that the local-first store appends to its
 * outbox and that the sync server orders by a global `seq`. It is the wire
 * boundary between machines: it is serialized to a JSON string to be stored in
 * the local outbox and shipped to the server, and is deserialized + re-
 * validated on the receiving side before it is applied.
 *
 * The three codecs are pure and synchronous:
 *
 *   parseOp(raw)          unknown      -> Op | null   (schema validation)
 *   serializeOp(op)       Op           -> string      (canonical JSON)
 *   deserializeOp(json)   string       -> Op | null   (JSON.parse + parseOp)
 *
 * Two properties make the codec safe at the wire boundary:
 *
 *   DETERMINISTIC — serializeOp emits the same bytes for the same logical op
 *   regardless of key insertion order, so an op is hashable for de-duplication
 *   and its serialized form is a stable identity.
 *
 *   STRICT — any untrusted value that is not a well-formed Op is rejected with
 *   `null` (never silently coerced into a partial object). This mirrors
 *   `parseGid`: a failed parse simply means "not a valid value".
 *
 * The codec is the subject of the TDD contract in `tests/storage/op.test.ts`.
 */

import { parseGid } from "../identity/gid.js";

/**
 * The closed set of mutation kinds an Op can carry (spec 1.3).
 *
 * The `calendar.*` family is instantiated per syncable calendar table
 * (entity / event / link) in upsert form. Adding a new kind here is the single
 * source of truth: `parseOp` rejects any `kind` not in this set, so a client
 * and a server on different versions fail closed rather than silently mis-
 * applying an op they cannot understand.
 */
export type OpKind =
  | "file.create"
  | "file.update"
  | "file.delete"
  | "file.move"
  | "folder.create"
  | "folder.delete"
  | "tag.set"
  | "favorite.set"
  | "project.register"
  | "project.unregister"
  | "calendar.entity.upsert"
  | "calendar.event.upsert"
  | "calendar.link.upsert"
  | "journal.meta.upsert";

/** Ops that version independently on the server: file content, metadata, and each other kind on its own. */
export type KindFamily =
  | "content"
  | "metadata"
  | "folder"
  | "project"
  | "calendar.entity"
  | "calendar.event"
  | "calendar.link"
  | "journal";

export function kindFamily(kind: OpKind): KindFamily {
  if (kind.startsWith("file.")) return "content";
  if (kind === "tag.set" || kind === "favorite.set") return "metadata";
  if (kind.startsWith("folder.")) return "folder";
  if (kind.startsWith("project.")) return "project";
  if (kind === "journal.meta.upsert") return "journal";
  return kind as KindFamily;
}

/** Runtime list of every {@link OpKind}; `parseOp` validates against this. */
export const OP_KINDS: readonly OpKind[] = [
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

/**
 * A single syncable mutation. Field names are snake_case to match the
 * codebase's SQLite column convention.
 */
export interface Op {
  /** Global record identifier, `<localId>@<machineId>` (see identity/gid.ts). */
  gid: string;
  /** The mutation kind; must be one of {@link OP_KINDS}. */
  kind: OpKind;
  /** The 16-hex `machine_id` of the machine that made this change. */
  origin: string;
  /**
   * The version the change was based on, for optimistic concurrency. `null`
   * for create ops (no prior version to base against).
   */
  base_version: number | null;
  /** JSON-serializable change payload (content, paths, metadata). */
  payload: unknown;
  /** Wall-clock ms timestamp; informative only — ordering comes from `seq`. */
  created_at: number;
}

/** True iff `v` is a plain object (not null, not an array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True iff `v` can be faithfully represented as JSON (rejects function/symbol/undefined). */
function isJsonSerializable(v: unknown): boolean {
  // JSON.stringify returns `undefined` (not a string) for top-level
  // functions, symbols, and undefined — exactly the non-serializable cases.
  return typeof JSON.stringify(v) === "string";
}

/** True iff `v` is a non-negative integer or `null` (a valid base_version). */
function isBaseVersion(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
}

/**
 * Validate an arbitrary value as an {@link Op}.
 *
 * Returns a normalized Op (exactly the six schema fields, unknown extras
 * stripped) or `null` if anything is malformed. Never throws: any unparseable
 * input — non-object, bad gid, unknown kind, bad origin/base_version/
 * created_at, or a non-JSON-serializable payload — yields `null`.
 */
export function parseOp(raw: unknown): Op | null {
  if (!isPlainObject(raw)) return null;

  // gid must be a well-formed <localId>@<machineId> (delegate to the GID codec).
  if (typeof raw.gid !== "string" || parseGid(raw.gid) == null) return null;

  // kind must be a known mutation kind.
  const kind = raw.kind;
  if (typeof kind !== "string" || !(OP_KINDS as readonly string[]).includes(kind)) {
    return null;
  }

  // origin must be a non-empty string (the originating machine_id).
  const origin = raw.origin;
  if (typeof origin !== "string" || origin.length === 0) return null;

  // base_version: non-negative integer or null (create ops).
  if (!isBaseVersion(raw.base_version)) return null;

  // created_at: a finite number (wall-clock ms).
  if (typeof raw.created_at !== "number" || !Number.isFinite(raw.created_at)) return null;

  // payload: must be JSON-serializable (and therefore storable / shippable).
  if (!isJsonSerializable(raw.payload)) return null;

  // Return a normalized copy with exactly the schema fields.
  return {
    gid: raw.gid as string,
    kind: kind as OpKind,
    origin,
    base_version: raw.base_version as number | null,
    payload: raw.payload,
    created_at: raw.created_at as number,
  };
}

/**
 * Recursively sort an object's own keys (and recurse into nested objects and
 * array elements) so a value's canonical JSON form is independent of the key
 * order it happened to arrive in. Primitives and `null` pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Serialize an {@link Op} to a canonical JSON string.
 *
 * Output depends only on the op's logical content, never on key insertion
 * order (both top-level and nested keys are sorted), so `serializeOp(a) ===
 * serializeOp(b)` whenever `a` and `b` are the same logical op. This stable
 * byte form is what lets the sync layer de-duplicate and compare ops by hash.
 */
export function serializeOp(op: Op): string {
  return JSON.stringify(canonicalize(op));
}

/**
 * Parse a JSON string back into a validated {@link Op}.
 *
 * Returns `null` for malformed JSON, for JSON that parses to a non-op
 * (number/string/null/boolean/array), and for JSON that parses to an object
 * failing {@link parseOp} (bad kind, missing field, etc.).
 */
export function deserializeOp(json: string): Op | null {
  if (typeof json !== "string") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return null;
  }
  return parseOp(decoded);
}
