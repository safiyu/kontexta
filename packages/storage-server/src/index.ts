/**
 * kontexta-storage-server — package entry.
 *
 * This is the authoritative op-log backend for Kontexta's local-first storage
 * sync (spec §1.6–§1.7). It accepts client operations over a short-polling
 * transport, assigns a global sequence number (`seq`) to each op (server clocks
 * are authoritative; client clocks are untrusted), and serves ordered op batches
 * back to connected clients via `GET /ops?since=<cursor>`.
 *
 * This module is currently a scaffold. The HTTP application, routing, auth, and
 * SQLite op store land in follow-up milestones:
 *   - `src/server.ts`         — Hono app bootstrap + routing
 *   - `src/auth.ts`           — shared client-token validation
 *   - `src/routes/ops.ts`     — POST/GET /ops, POST /clients, GET /health
 *   - `src/db/schema.sql`     — `ops` + `clients` tables
 */

/** Monotonic package version, surfaced on the `/health` endpoint. */
export const VERSION = "6.2.0";
