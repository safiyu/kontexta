import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { compilePattern } from "kontexta-mcp/hands/sanitizer";

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  const pattern = String(body?.pattern ?? "");
  const value = String(body?.value ?? "");
  try {
    const m = compilePattern(pattern);
    return NextResponse.json({ valid: true, matches: m.test(value) });
  } catch (e: any) {
    return NextResponse.json({ valid: false, error: e?.message ?? String(e) });
  }
}
