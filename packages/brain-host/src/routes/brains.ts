/**
 * Brain routes: join (create or enter a brain with its share id), the brain's own status,
 * machine management, and the snapshot a joining machine bootstraps from.
 *
 * Joining is the only route that takes a share id. It returns a per-machine bearer token; every other
 * request authenticates with that token and is scoped to its brain.
 */

import { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { DEFAULT_PEPPER, generateClientToken, hashToken } from "../auth.js";
import { BrainStore } from "../store.js";
import { authenticate } from "./ops.js";

const MACHINE_ID_RE = /^[0-9a-f]{16}$/;
const ROUTE_ID_RE = /^[0-9a-f]{64}$/;

/** The routing id is derived on the machine from the share id; the host never sees the share id or the encryption key. */
function hashRouteId(routeId: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`route:${routeId}`, "utf8").digest("hex");
}
const SNAPSHOT_DEFAULT = 200;
const SNAPSHOT_MAX = 1000;

export interface BrainsRouterOptions {
  pepper?: string;
  /** Required to create a brain; joining an existing one needs only the share id. */
  enrollSecret?: string;
  /** Dev/test only: allow creating a brain with no enrollment secret configured. */
  allowOpenCreate?: boolean;
}

function secretsEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return SNAPSHOT_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, SNAPSHOT_MAX) : null;
}

export function createBrainsRouter(db: Database.Database, options: BrainsRouterOptions = {}): Hono {
  const pepper = options.pepper ?? DEFAULT_PEPPER;
  const enrollSecret = options.enrollSecret ?? "";
  const allowOpenCreate = options.allowOpenCreate === true;
  const store = new BrainStore(db);
  const router = new Hono();

  router.post("/brains/join", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    const { route_id, machine_id, hostname, name } = body as Record<string, unknown>;
    if (typeof route_id !== "string" || !ROUTE_ID_RE.test(route_id)) {
      return c.json({ error: "route_id must be a 64-character lowercase hex string" }, 400);
    }
    if (typeof machine_id !== "string" || !MACHINE_ID_RE.test(machine_id)) {
      return c.json({ error: "machine_id must be a 16-character lowercase hex string" }, 400);
    }
    const host = typeof hostname === "string" && hostname.length > 0 && hostname.length <= 255 ? hostname : null;
    const brainName =
      typeof name === "string" && name.trim().length > 0 ? name.trim().slice(0, 120) : (host ?? "brain");

    const shareHash = hashRouteId(route_id, pepper);
    const token = generateClientToken();
    const tokenHash = hashToken(token, pepper);

    const result = db.transaction(() => {
      const existing = store.findBrainByShareHash(shareHash);
      if (existing) {
        if (store.hasMachine(existing.id, machine_id)) store.rotateToken(existing.id, machine_id, tokenHash, host);
        else store.enrollMachine(existing.id, machine_id, host, tokenHash);
        return { created: false as const, brainId: existing.id, name: existing.name };
      }
      if (enrollSecret === "") {
        if (!allowOpenCreate) return "closed" as const;
      } else {
        const presented = c.req.header("x-enroll-secret") ?? "";
        if (!secretsEqual(presented, enrollSecret)) return "denied" as const;
      }
      const brainId = store.createBrain(shareHash, brainName);
      store.enrollMachine(brainId, machine_id, host, tokenHash);
      return { created: true as const, brainId, name: brainName };
    })();

    if (result === "closed") {
      return c.json({ error: "creating a brain is closed: set KXTA_BRAIN_ENROLL_SECRET on the server" }, 503);
    }
    if (result === "denied") return c.json({ error: "invalid enrollment secret" }, 403);
    return c.json(
      {
        brain_id: result.brainId,
        name: result.name,
        created: result.created,
        token,
        latest_seq: store.latestSeq(result.brainId),
      },
      result.created ? 201 : 200,
    );
  });

  router.get("/brains/me", (c) => {
    const who = authenticate(db, c.req.header("authorization"), pepper);
    if (who === null) return c.json({ error: "unauthorized" }, 401);
    const brain = store.getBrain(who.brainId)!;
    return c.json({
      brain_id: brain.id,
      name: brain.name,
      latest_seq: store.latestSeq(who.brainId),
      machines: store.listMachines(who.brainId),
    });
  });

  router.patch("/brains/me", async (c) => {
    const who = authenticate(db, c.req.header("authorization"), pepper);
    if (who === null) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    if (typeof body?.name !== "string" || body.name.trim() === "") return c.json({ error: "name is required" }, 400);
    store.renameBrain(who.brainId, body.name.trim().slice(0, 120));
    return c.json({ brain_id: who.brainId, name: body.name.trim().slice(0, 120) });
  });

  router.delete("/brains/me/machines/:machine_id", (c) => {
    const who = authenticate(db, c.req.header("authorization"), pepper);
    if (who === null) return c.json({ error: "unauthorized" }, 401);
    return store.revokeMachine(who.brainId, c.req.param("machine_id"))
      ? c.body(null, 204)
      : c.json({ error: "no such machine in this brain" }, 404);
  });

  router.get("/brains/snapshot", (c) => {
    const who = authenticate(db, c.req.header("authorization"), pepper);
    if (who === null) return c.json({ error: "unauthorized" }, 401);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be a positive integer" }, 400);
    const page = store.snapshotPage(who.brainId, c.req.query("after") ?? "", limit);
    return c.json({ gids: page.gids, next: page.next, latest_seq: store.latestSeq(who.brainId) });
  });

  return router;
}
