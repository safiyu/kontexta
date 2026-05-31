import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { ensureDbInitialized } from "@/lib/db-init";
import { getDatabase } from "kxta-core";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Allow health checks from localhost (Docker/container health checks)
  // without requiring full session auth. This is safe because Docker's
  // health check runs inside the container, and the port is not exposed
  // to the internet (only localhost:3000 is reachable from inside).
  const hostHeader = req.headers.get("host") || "";
  const isLocalHealthCheck = hostHeader.startsWith("127.0.0.1:") || hostHeader.startsWith("[::1]:");

  if (!isLocalHealthCheck && !checkAuth(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    ensureDbInitialized();
    // Cheap connectivity probe: a SELECT 1 confirms the SQLite handle works.
    getDatabase().prepare("SELECT 1").get();
    return NextResponse.json({ status: "ok" });
  } catch (e: any) {
    return NextResponse.json({ status: "error", error: e?.message }, { status: 503 });
  }
}
