import { NextRequest, NextResponse } from "next/server";
import { loadDockerConfig, saveDockerConfig } from "@/lib/docker-config";

export async function GET() {
  const config = loadDockerConfig();
  return NextResponse.json(config);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    saveDockerConfig(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}
