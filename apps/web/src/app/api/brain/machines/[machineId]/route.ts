import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getDatabase, removeBrainMachine } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

/** DELETE /api/brain/machines/:machineId revokes a machine's access to this brain. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ machineId: string }> }) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });
  ensureDbInitialized();
  const { machineId } = await ctx.params;
  try {
    const ok = await removeBrainMachine(getDatabase(), machineId);
    return ok ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "no such machine in this brain" }, { status: 404 });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to remove machine" }, { status: 400 });
  }
}
