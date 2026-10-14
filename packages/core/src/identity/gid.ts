/**
 * GID (global id) codec — Phase 2 (storage/02-ids).
 *
 * A GID is a self-describing string that pairs a record's LOCAL database
 * integer id with the MACHINE that owns it: `<localId>@<machineId>`.
 *
 *   e.g. formatGid(104, "4f9e1a8b3c7d2e0f") -> "104@4f9e1a8b3c7d2e0f"
 *
 * The local integer PK is preserved untouched (so SQLite FTS5 `rowid` stays
 * aligned with `files.id`); the GID is a secondary, globally-unique identity
 * column that lets a sync server address a record across machines without
 * ever colliding on a bare local id.
 *
 * `formatGid` / `parseGid` are pure and synchronous. `isLocalGid` resolves
 * the local machine identity from `settings.machine_id` (seeded once by
 * migration 013) and is a total predicate: it never throws on malformed
 * input, it just returns false.
 */

import { getSetting } from "../metadata/settings.js";

/** The two parts a GID encodes. */
export interface GidParts {
  /** The local database integer id of the record. */
  localId: number;
  /** The 16-hex machine id that owns the record. */
  machineId: string;
}

/**
 * Build a GID from a local id and a machine id.
 *
 * Both parts must be non-empty. The local id is stringified as-is (it is an
 * integer PK in practice); the machine id is used verbatim.
 */
export function formatGid(localId: number, machineId: string): string {
  return `${localId}@${machineId}`;
}

/**
 * Parse a GID back into its parts, or return `null` if it is malformed.
 *
 * A well-formed GID has exactly one `@` separator, a non-empty machine id to
 * the right of it, and a local id on the left that is a non-negative integer
 * (the local PK). Anything else — empty string, no separator, empty local
 * part, empty machine part, or a non-numeric local part — is rejected with
 * `null` rather than throwing, so callers can treat a failed parse as "not a
 * valid GID".
 *
 * Note: a GID may contain at most one `@` (machine ids are 16-hex and never
 * contain `@`), so we split on the first separator.
 */
export function parseGid(gid: string): GidParts | null {
  if (typeof gid !== "string") return null;
  const at = gid.indexOf("@");
  // Reject an empty string, and any string whose first (and only) separator
  // is absent or at either end.
  if (at === -1) return null;

  const localPart = gid.slice(0, at);
  const machineId = gid.slice(at + 1);

  if (localPart.length === 0 || machineId.length === 0) return null;
  // Local id must be a non-negative integer (the local PK).
  if (!/^\d+$/.test(localPart)) return null;

  return { localId: Number(localPart), machineId };
}

/**
 * True if `gid` belongs to THIS machine (its machine id matches
 * `settings.machine_id`).
 *
 * This is a predicate, not a parser: any unparseable or foreign GID yields
 * `false`. It requires the database to be open (it reads the local machine
 * identity from settings).
 */
export function isLocalGid(gid: string): boolean {
  const parts = parseGid(gid);
  if (!parts) return false;
  return parts.machineId === getSetting("machine_id");
}
