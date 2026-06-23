import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "kxta-core";
import { verifyPassword, signSession, getClientIp } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";

// Simple in-memory rate limiter: tracks failed attempts per IP.
// Resets on server restart (acceptable for local-first app).
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

function isRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip: string, success: boolean) {
  const entry = loginAttempts.get(ip) ?? { count: 0, resetAt: Date.now() + LOCKOUT_MS };
  if (!success) entry.count++;
  else loginAttempts.delete(ip); // reset on success
  loginAttempts.set(ip, entry);
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  if (isRateLimited(ip)) {
    console.warn(`[Auth/Login] Rate limited: ${ip}`);
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }
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
      recordAttempt(ip, false);
      console.warn("[Auth/Login] Invalid password from", ip);
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
  } catch (err: any) {
    console.error("[Auth/Login] Password verification failed:", err);
    return NextResponse.json({ error: "Password verification failed" }, { status: 500 });
  }

  recordAttempt(ip, true);

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
