import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { refreshIndex } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

// Per-projectId in-flight set — concurrent refreshes of the same project
// race on the SQLite write lock and can duplicate `files` rows. Refreshes
// of different projects are independent.
const _refreshInFlight = new Set<number | null>();

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();

  let projectId: number | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.projectId !== undefined && body.projectId !== null && body.projectId !== "") {
      const parsed = typeof body.projectId === "number" ? body.projectId : parseInt(body.projectId, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
      }
      projectId = parsed;
    }

    if (_refreshInFlight.has(projectId)) {
      return NextResponse.json(
        { error: `refresh already in progress for ${projectId === null ? "all projects" : `project ${projectId}`}` },
        { status: 409 }
      );
    }
    _refreshInFlight.add(projectId);
    try {
      const result = await refreshIndex(projectId, DATA_DIR);
      return NextResponse.json({
        success: true,
        ...result
      });
    } finally {
      _refreshInFlight.delete(projectId);
    }
  } catch (error: any) {
    console.error(`[Refresh] Failed:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
