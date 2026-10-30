import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { listConflicts, countUnresolvedConflicts } from "kxta-core";
import type { ConflictStatus } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

/**
 * Conflict Manager — list endpoint (Phase 5).
 *
 *   GET /api/conflicts?status=unresolved&limit=100
 *
 * Query:
 *   - status: "unresolved" (default) | "resolved" | "all"
 *   - limit:  positive integer, applied to the returned list
 *
 * Response:
 *   GET /api/conflicts?count=1  ->  { count: number }  (cheap badge poll: no rows, no diffs)
 *
 *   { conflicts: ConflictRecord[], count: number, unresolved: number }
 *     - conflicts: the filtered list (newest first), WITHOUT diff/additions/deletions
 *       (fetch GET /api/conflicts/[gid] for the diff)
 *     - count: conflicts.length
 *     - unresolved: global unresolved total, for the top-bar indicator badge
 */
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();

  const sp = req.nextUrl.searchParams;

  if (sp.get("count") === "1") {
    try {
      return NextResponse.json({ count: countUnresolvedConflicts() });
    } catch (error: any) {
      return NextResponse.json({ error: error?.message ?? "Failed to count conflicts" }, { status: 500 });
    }
  }

  const statusRaw = sp.get("status");
  if (statusRaw !== null && statusRaw !== "unresolved" && statusRaw !== "resolved" && statusRaw !== "all") {
    return NextResponse.json(
      { error: `Invalid status: ${statusRaw} (expected unresolved, resolved, or all)` },
      { status: 400 }
    );
  }
  const status: ConflictStatus | "all" = statusRaw ?? "unresolved";

  let limit: number | undefined;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: `Invalid limit: ${limitRaw}` }, { status: 400 });
    }
    limit = n;
  }

  try {
    const conflicts = listConflicts(undefined, { status, limit });
    return NextResponse.json({
      conflicts,
      count: conflicts.length,
      unresolved: countUnresolvedConflicts(),
    });
  } catch (error: any) {
    console.error("listConflicts failed:", error);
    return NextResponse.json(
      { error: error?.message ?? "Failed to list conflicts" },
      { status: 500 }
    );
  }
}
