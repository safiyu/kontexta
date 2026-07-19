import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getEntity, updateEntity, deleteEntity } from "kxta-core";
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

  const entity = getEntity(n);
  if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 });
  return NextResponse.json(entity);
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
    name?: string;
    kind?: string | null;
    notes?: string | null;
    timezone?: string | null;
    active?: boolean;
  } = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string") return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    patch.name = b.name;
  }
  if (b.kind !== undefined) {
    if (b.kind !== null && typeof b.kind !== "string") return NextResponse.json({ error: "kind must be a string or null" }, { status: 400 });
    patch.kind = b.kind as string | null;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== "string") return NextResponse.json({ error: "notes must be a string or null" }, { status: 400 });
    patch.notes = b.notes as string | null;
  }
  if (b.timezone !== undefined) {
    if (b.timezone !== null && typeof b.timezone !== "string") return NextResponse.json({ error: "timezone must be a string or null" }, { status: 400 });
    patch.timezone = b.timezone as string | null;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
    patch.active = b.active;
  }

  try {
    const entity = updateEntity(n, patch);
    return NextResponse.json(entity);
  } catch (error: any) {
    const msg = error?.message ?? "Failed to update entity";
    const status = msg.startsWith("Unknown calendar entity") ? 404 : 400;
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

  try {
    const result = deleteEntity(n);
    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error?.message ?? "Failed to delete entity";
    const status = msg.startsWith("Unknown calendar entity") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
