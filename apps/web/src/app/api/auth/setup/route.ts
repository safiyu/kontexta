import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "kxta-core";
import { hashPassword, signSession } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";

export async function POST(req: NextRequest) {
  ensureDbInitialized();
  const existingHash = getSetting("auth_password_hash");
  if (existingHash) {
    return NextResponse.json({ error: "Password already configured" }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { password, bypassIps, trustProxyHeaders } = body;

  if (typeof password !== "string" || password.length < 4) {
    return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
  }

  const { hash, salt } = hashPassword(password);
  setSetting("auth_password_hash", hash);
  setSetting("auth_password_salt", salt);

  if (typeof bypassIps === "string") {
    setSetting("auth_bypass_ips", bypassIps);
  }

  setSetting("auth_trust_proxy_headers", trustProxyHeaders === true ? "true" : "false");

  const token = signSession({ t: Date.now() });
  
  const response = NextResponse.json({ success: true });
  response.cookies.set("kontexta_session", token, {
    httpOnly: true,
    secure: false, // See login/route.ts — HTTP Docker deployments require non-secure cookies.
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return response;
}
