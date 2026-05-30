import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { refreshIndex } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

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

  try {
    const result = await refreshIndex(projectIdNum, DATA_DIR);
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error(`[Refresh] Failed for project ${id}:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
