import { NextRequest, NextResponse } from "next/server";
import { ensureDbInitialized } from "@/lib/db-init";
import { checkAuth, signSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureDbInitialized();

  // Standard same-origin auth check via cookies/headers
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Generate a short-lived WS connection token
  const token = signSession({ t: Date.now() });

  return NextResponse.json({ token });
}
