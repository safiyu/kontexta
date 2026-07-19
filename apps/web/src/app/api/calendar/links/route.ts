import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { linkEntities, unlinkEntities, listLinks } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

function parseId(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const entityId = parseId(req.nextUrl.searchParams.get("entity_id"));
  const links = listLinks(entityId ?? undefined);
  return NextResponse.json(links);
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
  const from_entity_id = typeof b.from_entity_id === "number" ? b.from_entity_id : NaN;
  const to_entity_id = typeof b.to_entity_id === "number" ? b.to_entity_id : NaN;
  const label = typeof b.label === "string" ? b.label : undefined;

  if (!Number.isInteger(from_entity_id) || from_entity_id <= 0 || !Number.isInteger(to_entity_id) || to_entity_id <= 0) {
    return NextResponse.json({ error: "from_entity_id and to_entity_id must be positive integers" }, { status: 400 });
  }

  try {
    const link = linkEntities(from_entity_id, to_entity_id, label ?? null);
    return NextResponse.json(link, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to create link" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = req.nextUrl;
  const from = parseId(searchParams.get("from"));
  const to = parseId(searchParams.get("to"));
  if (from === null || to === null) {
    return NextResponse.json({ error: "from and to query params are required positive integers" }, { status: 400 });
  }

  const removed = unlinkEntities(from, to);
  return NextResponse.json({ removed });
}
