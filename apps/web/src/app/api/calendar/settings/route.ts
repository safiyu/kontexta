import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getBufferMinutes, setSetting, BUFFER_SETTING_KEY } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  return NextResponse.json({ buffer_minutes: getBufferMinutes() });
}

export async function PUT(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const buffer_minutes = b.buffer_minutes;
  if (typeof buffer_minutes !== "number" || !Number.isInteger(buffer_minutes) || buffer_minutes < 0 || buffer_minutes > 1440) {
    return NextResponse.json({ error: "buffer_minutes must be an integer between 0 and 1440" }, { status: 400 });
  }

  setSetting(BUFFER_SETTING_KEY, String(buffer_minutes));
  return NextResponse.json({ buffer_minutes });
}
