import { NextRequest, NextResponse } from "next/server";
import { readFile, updateFile, deleteFile, getDatabase, addTags, removeTags, setFavorite, getTagsForFiles } from "kxta-core";
import { ensureDbInitialized, DATA_DIR } from "@/lib/db-init";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
  try {
    const file = readFile(n);
    // Annotate with tags + favorite so the UI doesn't need a second round-trip.
    const tags = getTagsForFiles([n]).get(n) ?? [];
    const db = getDatabase();
    const isFav = !!db.prepare("SELECT 1 FROM favorites WHERE file_id = ?").get(n);
    return NextResponse.json({ ...file, tags, favorite: isFav });
  } catch (error) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }
  try {
    const updated = await updateFile(n, body.content, DATA_DIR);
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("Update failed:", error);
    const msg = error?.message ?? "Update failed";
    const status = msg.startsWith("File not found") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const db = getDatabase();
  const exists = db.prepare("SELECT id FROM files WHERE id = ?").get(n);
  if (!exists) return NextResponse.json({ error: "File not found" }, { status: 404 });

  if (body.favorite !== undefined && typeof body.favorite !== "boolean") {
    return NextResponse.json({ error: "favorite must be boolean" }, { status: 400 });
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((t: unknown) => typeof t === "string"))) {
    return NextResponse.json({ error: "tags must be string[]" }, { status: 400 });
  }

  // Atomic so a constraint failure can't half-apply favorite + tags.
  db.transaction(() => {
    if (body.favorite !== undefined) {
      setFavorite(n, body.favorite);
    }

    if (body.tags !== undefined) {
      const currentMap = getTagsForFiles([n]);
      const current = currentMap.get(n) ?? [];
      const desired = body.tags as string[];
      const toAdd = desired.filter((t) => !current.includes(t));
      const toRemoveNames = current.filter((t) => !desired.includes(t));
      if (toAdd.length > 0) addTags(n, toAdd);
      if (toRemoveNames.length > 0) {
        const idRows = db
          .prepare(`SELECT id FROM tags WHERE name IN (${toRemoveNames.map(() => "?").join(",")})`)
          .all(...toRemoveNames) as { id: number }[];
        removeTags(n, idRows.map((r) => r.id));
      }
    }
  })();

  const updated = readFile(n);
  const tags = getTagsForFiles([n]).get(n) ?? [];
  const isFav = !!db
    .prepare("SELECT 1 FROM favorites WHERE file_id = ?")
    .get(n);
  return NextResponse.json({ ...updated, tags, favorite: isFav });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
  try {
    deleteFile(n, DATA_DIR);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Delete failed:", error);
    const msg = error?.message ?? "Delete failed";
    const status = msg.startsWith("File not found") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
