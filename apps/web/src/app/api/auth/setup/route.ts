import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "kxta-core";
import { hashPassword, signSession } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";

export async function POST(req: NextRequest) {
  try {
    ensureDbInitialized();
  } catch (err: any) {
    console.error("[Auth/Setup] Database initialization failed:", err);
    return NextResponse.json({ error: "Database initialization failed" }, { status: 500 });
  }

  let existingHash: string | null = null;
  try {
    existingHash = getSetting("auth_password_hash");
  } catch (err: any) {
    console.error("[Auth/Setup] Failed to check existing password:", err);
    return NextResponse.json({ error: "Failed to check auth status" }, { status: 500 });
  }

  if (existingHash) {
    console.warn("[Auth/Setup] Password already configured");
    return NextResponse.json({ error: "Password already configured" }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    console.error("[Auth/Setup] Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { password, bypassIps, trustProxyHeaders } = body;

  if (typeof password !== "string" || password.length < 4) {
    console.warn("[Auth/Setup] Password validation failed");
    return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
  }

  try {
    const { hash, salt } = hashPassword(password);
    setSetting("auth_password_hash", hash);
    setSetting("auth_password_salt", salt);

    if (typeof bypassIps === "string") {
      setSetting("auth_bypass_ips", bypassIps);
    }

    setSetting("auth_trust_proxy_headers", trustProxyHeaders === true ? "true" : "false");
  } catch (err: any) {
    console.error("[Auth/Setup] Failed to save settings:", err);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }

  let token: string;
  try {
    token = signSession({ t: Date.now() });
  } catch (err: any) {
    console.error("[Auth/Setup] Failed to sign session:", err);
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
  }
  
  const response = NextResponse.json({ success: true });
  response.cookies.set("kontexta_session", token, {
    httpOnly: true,
    secure: false, // See login/route.ts — HTTP Docker deployments require non-secure cookies.
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  console.log("[Auth/Setup] Setup completed successfully");
  return response;
}
