import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "kxta-core";
import { verifyPassword, signSession } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";

export async function POST(req: NextRequest) {
  ensureDbInitialized();
  const hash = getSetting("auth_password_hash");
  const salt = getSetting("auth_password_salt");
  
  if (!hash || !salt) {
    return NextResponse.json({ error: "Auth not configured" }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { password } = body;
  if (typeof password !== "string") {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  if (!verifyPassword(password, hash, salt)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = signSession({ t: Date.now() });
  
  const response = NextResponse.json({ success: true });
  response.cookies.set("kontexta_session", token, {
    httpOnly: true,
    // Do not force secure:true — Kontexta is commonly deployed over HTTP
    // (Docker on a local machine or behind a reverse proxy). Secure cookies
    // would be silently dropped by browsers over HTTP, breaking the login flow.
    // Users who expose Kontexta over HTTPS can enable a reverse proxy; the
    // HMAC-signed token + httpOnly + sameSite:lax still provides strong protection.
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  // Clear the explicit lock so IP bypass resumes if configured.
  response.cookies.delete("kontexta_locked");

  return response;
}
