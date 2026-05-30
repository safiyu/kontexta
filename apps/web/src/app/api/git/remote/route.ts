import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { getGlobalRemote, setGlobalRemote } from "kxta-core";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  try {
    const url = await getGlobalRemote(DATA_DIR);
    return NextResponse.json({ remote_url: url });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const raw = (body as { remote_url?: unknown })?.remote_url;
  // Accept undefined/null/"" as "clear the remote". Anything else must be a string.
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    return NextResponse.json(
      { error: "remote_url must be a string (or null/empty to clear)" },
      { status: 400 }
    );
  }
  const remote_url = typeof raw === "string" ? raw.trim() : "";

  try {
    await setGlobalRemote(DATA_DIR, remote_url);
    return NextResponse.json({ success: true, remote_url });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
