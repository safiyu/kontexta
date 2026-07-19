import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getEvent, updateEvent, deleteEvent } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });

  const event = getEvent(n);
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  return NextResponse.json(event);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const patch: {
    entity_id?: number;
    type?: string;
    title?: string;
    notes?: string | null;
    starts_at?: string;
    ends_at?: string;
    original_timezone?: string | null;
    source?: string | null;
  } = {};

  if (b.entity_id !== undefined) {
    if (typeof b.entity_id !== "number" || !Number.isInteger(b.entity_id) || b.entity_id <= 0) {
      return NextResponse.json({ error: "entity_id must be a positive integer" }, { status: 400 });
    }
    patch.entity_id = b.entity_id;
  }
  if (b.type !== undefined) {
    if (typeof b.type !== "string") return NextResponse.json({ error: "type must be a string" }, { status: 400 });
    patch.type = b.type;
  }
  if (b.title !== undefined) {
    if (typeof b.title !== "string") return NextResponse.json({ error: "title must be a string" }, { status: 400 });
    patch.title = b.title;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== "string") return NextResponse.json({ error: "notes must be a string or null" }, { status: 400 });
    patch.notes = b.notes as string | null;
  }
  if (b.starts_at !== undefined) {
    if (typeof b.starts_at !== "string") return NextResponse.json({ error: "starts_at must be a string" }, { status: 400 });
    patch.starts_at = b.starts_at;
  }
  if (b.ends_at !== undefined) {
    if (typeof b.ends_at !== "string") return NextResponse.json({ error: "ends_at must be a string" }, { status: 400 });
    patch.ends_at = b.ends_at;
  }
  if (b.original_timezone !== undefined) {
    if (b.original_timezone !== null && typeof b.original_timezone !== "string") return NextResponse.json({ error: "original_timezone must be a string or null" }, { status: 400 });
    patch.original_timezone = b.original_timezone as string | null;
  }
  if (b.source !== undefined) {
    if (b.source !== null && typeof b.source !== "string") return NextResponse.json({ error: "source must be a string or null" }, { status: 400 });
    patch.source = b.source as string | null;
  }

  try {
    const event = updateEvent(n, patch);
    return NextResponse.json(event);
  } catch (error: any) {
    const msg = error?.message ?? "Failed to update event";
    const status = msg.startsWith("Unknown calendar event") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });

  const deleted = deleteEvent(n);
  if (!deleted) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
