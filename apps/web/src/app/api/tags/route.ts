import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { listTagsWithCounts } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const tags = listTagsWithCounts();
  return NextResponse.json(tags);
}
