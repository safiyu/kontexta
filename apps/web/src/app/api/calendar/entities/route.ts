import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { createEntity, listEntities } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = req.nextUrl;
  const active_only = searchParams.get("active_only") === "true";
  const kind = searchParams.get("kind") ?? undefined;

  const entities = listEntities({ active_only, kind });
  return NextResponse.json(entities);
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name : undefined;
  const kind = typeof b.kind === "string" ? b.kind : undefined;
  const notes = typeof b.notes === "string" ? b.notes : undefined;
  const timezone = typeof b.timezone === "string" ? b.timezone : undefined;

  if (!name || !name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const entity = createEntity({ name, kind, notes, timezone });
    return NextResponse.json(entity, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to create entity" }, { status: 400 });
  }
}
