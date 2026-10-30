import { checkAuth, verifyPassword } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getDatabase, getSetting, revealShareId } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

/** POST /api/brain/share { password } reveals the full share id after re-checking the master password (when one is set). */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });
  ensureDbInitialized();
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const hash = getSetting("auth_password_hash");
  const salt = getSetting("auth_password_salt");
  // With no master password configured the whole dashboard is open, so there is nothing to re-check.
  if (hash && salt && (typeof body?.password !== "string" || !verifyPassword(body.password, hash, salt))) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 403 });
  }
  const shareId = revealShareId(getDatabase());
  if (!shareId) return NextResponse.json({ error: "This machine did not keep the share id" }, { status: 404 });
  return NextResponse.json({ shareId });
}
