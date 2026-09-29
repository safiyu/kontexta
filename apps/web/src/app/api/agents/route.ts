import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { agentsState } from "@/lib/agents-state";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureDbInitialized();
  return NextResponse.json(agentsState());
}
