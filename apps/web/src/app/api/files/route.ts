import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { listFiles, createFile, getTagsForFiles, getDatabase } from "kxta-core";
import type { FileFilters } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

// Sample the head to detect ASCII-vs-multi-byte; pick bytes/4 or bytes/3.
function estimateTokens(filePath: string, sizeBytes: number): number {
  if (sizeBytes <= 0) return 1;
  const sampleSize = Math.min(4096, sizeBytes);
  let mostlyAscii = true;
  if (sampleSize >= 256) {
    let fd: number | null = null;
    try {
      fd = openSync(filePath, "r");
      const buf = Buffer.alloc(sampleSize);
      readSync(fd, buf, 0, sampleSize, 0);
      mostlyAscii = buf.toString("utf-8").length > sampleSize * 0.7;
    } catch {} finally {
      if (fd !== null) try { closeSync(fd); } catch {}
    }
  }
  return Math.max(1, Math.ceil(sizeBytes / (mostlyAscii ? 4 : 3)));
}

const DEFAULT_FILE_LIST_LIMIT = 5000;
const MAX_FILE_LIST_LIMIT = 50000;

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = req.nextUrl;
  const projectId = searchParams.get("project_id");
  const tag = searchParams.get("tag");
  const favorite = searchParams.get("favorite");
  const folder = searchParams.get("folder");
  const limitParam = searchParams.get("limit");

  const filters: FileFilters = {};
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_FILE_LIST_LIMIT) {
      return NextResponse.json(
        { error: `limit must be a positive integer <= ${MAX_FILE_LIST_LIMIT}` },
        { status: 400 }
      );
    }
    filters.limit = n;
  } else {
    filters.limit = DEFAULT_FILE_LIST_LIMIT;
  }

  if (projectId !== null) {
    // "none" = KB files (project_id IS NULL); anything else must be a real id.
    if (projectId === "none") {
      filters.project_id = null;
    } else {
      const n = Number(projectId);
      if (!Number.isInteger(n) || n < 0) {
        return NextResponse.json(
          { error: `Invalid project_id: ${projectId}` },
          { status: 400 }
        );
      }
      filters.project_id = n;
    }
  }
  if (tag) filters.tag = tag;
  if (favorite) filters.favorite = favorite === "true";
  if (folder) filters.folder = folder;

  const files = listFiles({ dataDir: DATA_DIR, filters });

  // Bulk-fetch tags + favorites in one shot to avoid N+1 queries.
  const ids = files.map((f) => f.id);
  const tagMap = getTagsForFiles(ids);
  const db = getDatabase();
  const favSet = new Set<number>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const favRows = db
      .prepare(`SELECT file_id FROM favorites WHERE file_id IN (${placeholders})`)
      .all(...ids) as { file_id: number }[];
    for (const r of favRows) favSet.add(r.file_id);
  }

  const annotated = files.map((f) => {
    let size_bytes: number | null = null;
    let est_tokens: number | null = null;
    try {
      size_bytes = statSync(f.path).size;
      est_tokens = estimateTokens(f.path, size_bytes);
    } catch {}
    return {
      ...f,
      size_bytes,
      est_tokens,
      tags: tagMap.get(f.id) ?? [],
      favorite: favSet.has(f.id),
    };
  });

  return NextResponse.json(annotated);
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
  try {
    const file = await createFile({ ...(body as object), dataDir: DATA_DIR } as any);
    return NextResponse.json(file, { status: 201 });
  } catch (error: any) {
    console.error("createFile failed:", error);
    return NextResponse.json(
      { error: error?.message ?? "Failed to create file" },
      { status: 400 }
    );
  }
}
