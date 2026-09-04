import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { readResource, getDataDir } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });
  ensureDbInitialized();
  const { name } = await params;
  try {
    const { bytes, mime } = readResource(getDataDir(), name);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err: any) {
    if (String(err?.code) === "ENOENT") return new NextResponse("Not found", { status: 404 });
    if (String(err?.message ?? "").includes("unsafe filename")) return new NextResponse("Bad name", { status: 400 });
    return new NextResponse("Error", { status: 500 });
  }
}
