/**
 * Client token auth — Phase 4 (storage/04-server).
 *
 * Every machine that syncs with the server holds a long-lived secret TOKEN.
 * The server never stores the token in plaintext: it stores only a one-way,
 * peppered hash in `clients.token_hash` (schema.sql) and validates each
 * request by re-deriving the hash and doing an indexed lookup.
 *
 * Why HMAC-SHA256 (peppered) rather than a slow KDF (scrypt/bcrypt):
 *   * The token is a 256-bit random value (TOKEN_BYTES). Brute-forcing it is
 *     infeasible, so a slow hash buys nothing against an attacker who does NOT
 *     know the token.
 *   * The hash MUST be deterministic so it can be an indexed column and a
 *     request can be validated with a single O(1) `WHERE token_hash = ?`.
 *     A random-salt KDF is non-deterministic and would force a full table
 *     scan per request — untenable for a short-polling backend.
 *   * The pepper binds the hash to a per-deployment secret, so leaking the
 *     database (hashes only) does not let an attacker forge or replay tokens
 *     without also learning the pepper.
 *
 * The primitives here are pure and synchronous. They are the shared building
 * blocks for the `POST /clients` (register) and `/ops` (authenticated) routes
 * (routes/ops.ts) — those own the HTTP concerns; this module owns the crypto.
 */

import { createHmac, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Token length in bytes (256 bits). As hex this is 64 chars — comfortably
 * beyond brute-force reach, the standard size for long-lived API tokens.
 */
export const TOKEN_BYTES = 32;

/**
 * The default HMAC pepper. A production deployment MUST override this with a
 * per-instance secret (see the server bootstrap, which reads
 * `KXTA_STORAGE_PEPPER`) — the default exists so local dev and tests run
 * without wiring environment config, and because it is NOT the secret that
 * protects a real deployment.
 */
export const DEFAULT_PEPPER = "kontexta-storage-server-default-pepper-v1";

/**
 * Mint a fresh client token: TOKEN_BYTES random bytes as lowercase hex.
 * Returned to the client exactly ONCE (at registration) and never stored.
 */
export function generateClientToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Derive the deterministic, peppered token hash stored in
 * `clients.token_hash`.
 *
 *   hash = HMAC-SHA256(key = pepper, message = token) as hex
 *
 * Deterministic for a fixed pepper (so it indexes and validates in O(1));
 * different for different peppers (so the DB is useless without the secret).
 */
export function hashToken(token: string, pepper: string = DEFAULT_PEPPER): string {
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

/** Resolve a presented token to its brain and machine, or null when unknown. */
export function validateClientToken(
  db: Database.Database,
  token: string,
  pepper: string = DEFAULT_PEPPER,
): { brainId: number; machineId: string } | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const row = db
    .prepare("SELECT brain_id, machine_id FROM clients WHERE token_hash = ?")
    .get(hashToken(token, pepper)) as { brain_id: number; machine_id: string } | undefined;
  return row ? { brainId: row.brain_id, machineId: row.machine_id } : null;
}
