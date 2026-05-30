import { NextRequest, NextResponse } from "next/server";
import { refreshIndex } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

export async function POST(req: NextRequest) {
  ensureDbInitialized();
  
  try {
    const body = await req.json().catch(() => ({}));
    let projectId: number | null = null;
    if (body.projectId !== undefined && body.projectId !== null && body.projectId !== "") {
      const parsed = typeof body.projectId === "number" ? body.projectId : parseInt(body.projectId, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
      }
      projectId = parsed;
    }

    const result = await refreshIndex(projectId, DATA_DIR);
    
    return NextResponse.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    console.error(`[Refresh] Failed:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
