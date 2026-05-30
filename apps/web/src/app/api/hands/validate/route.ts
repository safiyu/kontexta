import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { validateConfig } from "kontexta-mcp/hands/loader";

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const result = validateConfig(body, "/unused");
  return NextResponse.json(result);
}
