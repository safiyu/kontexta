import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { findConflicts } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to query params are required" }, { status: 400 });
  }

  const entityIdsParam = searchParams.get("entity_ids");
  let entity_ids: number[] | undefined;
  if (entityIdsParam) {
    entity_ids = entityIdsParam.split(",").map((s) => Number(s.trim()));
    if (entity_ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      return NextResponse.json({ error: `Invalid entity_ids: ${entityIdsParam}` }, { status: 400 });
    }
  }

  const bufferParam = searchParams.get("buffer_minutes");
  let buffer_minutes: number | undefined;
  if (bufferParam !== null) {
    const n = Number(bufferParam);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: `Invalid buffer_minutes: ${bufferParam}` }, { status: 400 });
    }
    buffer_minutes = n;
  }

  try {
    const result = findConflicts({ from, to, entity_ids, buffer_minutes });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to compute conflicts" }, { status: 400 });
  }
}
