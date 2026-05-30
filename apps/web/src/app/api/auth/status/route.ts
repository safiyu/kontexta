import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting, deleteSetting } from "kxta-core";
import { hashPassword, verifyPassword, signSession } from "@/lib/auth";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

export async function GET(req: NextRequest) {
  ensureDbInitialized();
  const hash = getSetting("auth_password_hash");
  
  return NextResponse.json({
    setup_required: !hash,
  });
}
