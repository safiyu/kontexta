import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { syncBackup } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { broadcastSync } from "@/lib/websocket";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { id } = await params;
  const projectIdNum = parseInt(id, 10);
  if (!Number.isInteger(projectIdNum) || projectIdNum <= 0) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }
  const start = Date.now();
  console.log(`[Sync] Starting sync for project ${id}...`);
  broadcastSync({ type: "sync:start", projectId: projectIdNum, at: start });
  try {
    const backedUp = await syncBackup(projectIdNum, DATA_DIR, (stage) => {
      broadcastSync({ type: "sync:stage", projectId: projectIdNum, at: Date.now(), stage });
    });
    console.log(`[Sync] Completed. Backed up ${backedUp.length} files.`);
    broadcastSync({
      type: "sync:done",
      projectId: projectIdNum,
      at: Date.now(),
      durationMs: Date.now() - start,
    });
    return NextResponse.json({ backed_up: backedUp.length });
  } catch (error: any) {
    console.error(`[Sync] Failed for project ${id}:`, error.message);
    broadcastSync({
      type: "sync:error",
      projectId: projectIdNum,
      at: Date.now(),
      message: error.message || "Sync failed",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
