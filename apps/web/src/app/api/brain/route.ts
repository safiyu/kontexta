import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import {
  bootstrapIfNeeded,
  disconnectBrain,
  fetchBrainStatus,
  getDatabase,
  getSyncCursor,
  joinBrain,
  maskShareId,
  pendingCount,
  readBrainConfig,
  revealShareId,
} from "kxta-core";
import { hostname } from "node:os";
import { ensureDbInitialized } from "@/lib/db-init";

/**
 * Brain connection.
 *
 *   GET    /api/brain  -> status (connection, masked share id, machines, pending, skipped, cursor)
 *   POST   /api/brain  { url, shareId? | create?, name?, enrollSecret? } -> join or create; the full share id is
 *                        returned once, on create
 *   DELETE /api/brain  -> disconnect (the brain's history stays on this machine)
 */
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });
  ensureDbInitialized();
  const db = getDatabase();
  const cfg = readBrainConfig(db);
  // A page load must not wait on a slow remote.
  const remote = cfg.connected ? await fetchBrainStatus(db, { requestTimeoutMs: 3000 }) : null;
  const kept = revealShareId(db);
  const skipped = (db.prepare("SELECT COUNT(*) AS n FROM sync_skipped_ops WHERE skipped = 1").get() as { n: number }).n;
  return NextResponse.json({
    connected: cfg.connected,
    name: cfg.name || null,
    remote: cfg.connected ? cfg.remoteUrl : null,
    shareId: kept ? maskShareId(kept) : null,
    machines: remote?.machines ?? null,
    remoteReachable: cfg.connected ? remote !== null : null,
    pending: pendingCount(db),
    skipped,
    cursor: getSyncCursor(db),
  });
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });
  ensureDbInitialized();
  const body = (await req.json().catch(() => null)) as {
    url?: unknown;
    shareId?: unknown;
    create?: unknown;
    name?: unknown;
    enrollSecret?: unknown;
  } | null;
  if (typeof body?.url !== "string" || body.url.trim() === "") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  const create = body.create === true;
  const shareId = typeof body.shareId === "string" && body.shareId.trim() !== "" ? body.shareId : undefined;
  if (!create && !shareId) {
    return NextResponse.json({ error: "pass a share id to join, or create a new brain" }, { status: 400 });
  }
  try {
    const db = getDatabase();
    const result = await joinBrain(db, body.url, {
      shareId,
      create,
      name: typeof body.name === "string" ? body.name : undefined,
      enrollSecret: typeof body.enrollSecret === "string" && body.enrollSecret !== "" ? body.enrollSecret : undefined,
      hostname: hostname(),
    });
    const boot = await bootstrapIfNeeded(db);
    return NextResponse.json({
      connected: true,
      name: result.name,
      created: result.created,
      shareId: result.created ? result.shareId : undefined,
      bootstrap: boot,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to connect" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });
  ensureDbInitialized();
  disconnectBrain(getDatabase());
  return NextResponse.json({ connected: false });
}
