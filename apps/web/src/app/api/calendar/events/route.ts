import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { createEvent, listEvents } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from") ?? undefined;
  const to = searchParams.get("to") ?? undefined;
  const typeParam = searchParams.get("type") ?? undefined;
  const entityIdParam = searchParams.get("entity_id");
  const limitParam = searchParams.get("limit");

  let entity_id: number | undefined;
  if (entityIdParam !== null) {
    const n = Number(entityIdParam);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: `Invalid entity_id: ${entityIdParam}` }, { status: 400 });
    }
    entity_id = n;
  }

  let limit: number | undefined;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: `Invalid limit: ${limitParam}` }, { status: 400 });
    }
    limit = n;
  }

  try {
    const events = listEvents({ from, to, entity_id, type: typeParam, limit });
    return NextResponse.json(events);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to list events" }, { status: 400 });
  }
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
  const entity_id = typeof b.entity_id === "number" ? b.entity_id : NaN;
  const type = typeof b.type === "string" ? b.type : undefined;
  const title = typeof b.title === "string" ? b.title : undefined;
  const starts_at = typeof b.starts_at === "string" ? b.starts_at : undefined;
  const ends_at = typeof b.ends_at === "string" ? b.ends_at : undefined;
  const notes = typeof b.notes === "string" ? b.notes : undefined;
  const original_timezone = typeof b.original_timezone === "string" ? b.original_timezone : undefined;
  const source = typeof b.source === "string" ? b.source : "web";

  if (!Number.isInteger(entity_id) || entity_id <= 0 || !type || !title || !starts_at || !ends_at) {
    return NextResponse.json(
      { error: "entity_id, type, title, starts_at, and ends_at are required" },
      { status: 400 }
    );
  }

  try {
    const event = createEvent({ entity_id, type, title, notes, starts_at, ends_at, original_timezone, source });
    return NextResponse.json(event, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to create event" }, { status: 400 });
  }
}
