import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { search, FtsQueryError } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q");

  if (!q) {
    return NextResponse.json([]);
  }

  try {
    const results = search({ query: q });
    return NextResponse.json(results);
  } catch (e: any) {
    if (e instanceof FtsQueryError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
