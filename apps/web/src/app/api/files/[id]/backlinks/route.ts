import { NextRequest, NextResponse } from "next/server";
import { findBacklinks } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });
  ensureDbInitialized();
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
  }
  const backlinks = findBacklinks(n);
  return NextResponse.json({ backlinks });
}
