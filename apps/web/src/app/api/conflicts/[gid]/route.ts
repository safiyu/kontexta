import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getConflict, resolveConflict } from "kxta-core";
import type { ConflictStrategy } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

const STRATEGIES: ConflictStrategy[] = ["keep-server", "keep-mine", "keep-both", "merged"];

/**
 * Conflict Manager — detail + resolution endpoint (Phase 5).
 *
 *   GET  /api/conflicts/[gid]   -> full ConflictRecord (diff + both snapshots)
 *   POST /api/conflicts/[gid]   -> body: { strategy, mergedContent? }
 *
 * Resolution strategies (spec 1.7):
 *   - keep-server: accept remote state, delete conflict copy.
 *   - keep-mine:   re-assert local state, push to server, delete conflict copy.
 *   - keep-both:   retain canonical + keep the conflict copy as a new tracked file.
 *   - merged:      apply user-provided mergedContent, push update, delete copy.
 *
 * Status mapping:
 *   200 resolved
 *   400 invalid strategy / missing mergedContent / malformed body
 *   404 no conflict for this gid
 *   409 conflict already resolved (no unresolved conflict to act on)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ gid: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { gid: rawGid } = await params;
  const gid = decodeURIComponent(rawGid);
  if (!gid) return NextResponse.json({ error: "Invalid gid" }, { status: 400 });

  try {
    const conflict = getConflict(gid);
    if (!conflict) {
      return NextResponse.json({ error: "No conflict found for this gid", gid }, { status: 404 });
    }
    return NextResponse.json(conflict);
  } catch (error: any) {
    console.error("getConflict failed:", error);
    return NextResponse.json(
      { error: error?.message ?? "Failed to load conflict" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ gid: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { gid: rawGid } = await params;
  const gid = decodeURIComponent(rawGid);
  if (!gid) return NextResponse.json({ error: "Invalid gid" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const strategy = b.strategy;

  if (typeof strategy !== "string" || !STRATEGIES.includes(strategy as ConflictStrategy)) {
    return NextResponse.json(
      { error: `Invalid strategy: ${String(strategy)} (expected one of ${STRATEGIES.join(", ")})` },
      { status: 400 }
    );
  }

  // `merged` requires the user-authored merged text.
  let mergedContent: string | undefined;
  if (strategy === "merged") {
    if (typeof b.mergedContent !== "string") {
      return NextResponse.json(
        { error: "merged strategy requires mergedContent (a string)" },
        { status: 400 }
      );
    }
    mergedContent = b.mergedContent;
  }

  try {
    const result = await resolveConflict(gid, { strategy: strategy as ConflictStrategy, mergedContent });
    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error?.message ?? "Failed to resolve conflict";
    // The core engine throws "No unresolved conflict found for gid: ..." when the
    // conflict was already resolved or never existed — map to 409 (state conflict)
    // so the UI can prompt a refresh rather than a generic failure.
    const status = msg.includes("No unresolved conflict") ? 409 : 400;
    return NextResponse.json({ error: msg, gid }, { status });
  }
}
