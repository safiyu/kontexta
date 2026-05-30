import { NextResponse } from "next/server";
import { ensureDbInitialized } from "@/lib/db-init";
import { getDatabase } from "kxta-core";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    ensureDbInitialized();
    // Cheap connectivity probe: a SELECT 1 confirms the SQLite handle works.
    getDatabase().prepare("SELECT 1").get();
    return NextResponse.json({ status: "ok" });
  } catch (e: any) {
    return NextResponse.json({ status: "error", error: e?.message }, { status: 503 });
  }
}
