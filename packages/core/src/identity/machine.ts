/**
 * Machine identity + client registry — Phase 2 (storage/02-ids).
 *
 * A vault lives on one machine but can be reached from many processes/machines
 * (apps/web, apps/mcp, a remote client). This module owns:
 *
 *   * The STABLE per-machine identity, `settings.machine_id` (a 16-hex string
 *     generated ONCE by migration 013 and never rotated). All GIDs minted on
 *     this machine embed this id (see gid.ts).
 *   * A human-readable `settings.machine_label` used to name conflict copies
 *     ("<name> (from <label>).ext").
 *   * The `clients` registry: one row per machine that has ever connected, so
 *     the UI can show which machines are part of the sync group.
 *
 * Every function here reads the shared DB singleton via getDatabase() (or the
 * settings helpers, which do the same). Migration 013 guarantees the
 * `clients` table and the `machine_id`/`machine_label` settings rows exist, so
 * these functions assume a migrated database.
 */

import { getDatabase } from "../db/index.js";
import { getSetting, setSetting } from "../metadata/settings.js";

/** A row in the `clients` registry (raw snake_case columns, per codebase convention). */
export interface ClientRecord {
  /** The stable 16-hex machine id (primary key). */
  machine_id: string;
  /** Hostname of the most recent connection from this machine. */
  hostname: string;
  /** When this machine first connected (UTC, `datetime('now')`). */
  first_seen_at: string;
  /** When this machine last connected (UTC, `datetime('now')`). */
  last_seen_at: string;
}

/**
 * The stable per-machine identity. Returns `settings.machine_id`, a 16-hex
 * string seeded once by migration 013. Stable for the life of the vault and
 * equal to a plain `getSetting("machine_id")` read.
 */
export function getMachineId(): string {
  return getSetting("machine_id") as string;
}

/**
 * The human-readable label for this machine (used in conflict-copy naming).
 * Seeded empty by migration 013; `null` if the setting is somehow absent.
 */
export function getMachineLabel(): string | null {
  return getSetting("machine_label");
}

/**
 * Set the human-readable label for this machine. Persists to
 * `settings.machine_label`.
 */
export function setMachineLabel(label: string): void {
  setSetting("machine_label", label);
}

/**
 * Record that THIS machine has (re)connected from `hostname`.
 *
 * Upserts the local machine's row in `clients`, keyed on `machine_id`:
 *   * first connect -> inserts a row (first_seen_at = last_seen_at = now).
 *   * reconnect (same or new hostname) -> updates `hostname` and
 *     `last_seen_at`, and PRESERVES `first_seen_at`.
 *
 * One row per machine, never one per hostname.
 */
export function recordClientConnected(hostname: string): void {
  const db = getDatabase();
  const machineId = getMachineId();
  db.prepare(
    `INSERT INTO clients (machine_id, hostname)
     VALUES (?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET
       hostname = excluded.hostname,
       last_seen_at = datetime('now')`,
  ).run(machineId, hostname);
}

/**
 * List all clients that have ever connected, most-recently-seen first.
 * Returns raw client rows (snake_case columns).
 */
export function listClients(): ClientRecord[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT machine_id, hostname, first_seen_at, last_seen_at
       FROM clients
       ORDER BY last_seen_at DESC, machine_id ASC`,
    )
    .all() as ClientRecord[];
}
