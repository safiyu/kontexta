import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "kxta-core";
import { verifyPassword, signSession } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";

export async function POST(req: NextRequest) {
  try {
    ensureDbInitialized();
  } catch (err: any) {
    console.error("[Auth/Login] Database initialization failed:", err);
    return NextResponse.json({ error: "Database initialization failed" }, { status: 500 });
  }

  let hash: string | null = null;
  let salt: string | null = null;
  
  try {
    hash = getSetting("auth_password_hash");
    salt = getSetting("auth_password_salt");
  } catch (err: any) {
    console.error("[Auth/Login] Failed to retrieve auth settings:", err);
    return NextResponse.json({ error: "Failed to retrieve auth settings" }, { status: 500 });
  }
  
  if (!hash || !salt) {
    console.warn("[Auth/Login] Auth not configured (no hash/salt found)");
    return NextResponse.json({ error: "Auth not configured" }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    console.error("[Auth/Login] Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { password } = body;
  if (typeof password !== "string") {
    console.error("[Auth/Login] Password not provided or not a string");
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  try {
    if (!verifyPassword(password, hash, salt)) {
      console.warn("[Auth/Login] Invalid password");
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
  } catch (err: any) {
    console.error("[Auth/Login] Password verification failed:", err);
    return NextResponse.json({ error: "Password verification failed" }, { status: 500 });
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

  console.log("[Auth/Login] Authentication successful");
  return response;
}
