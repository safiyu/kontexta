import { NextRequest, NextResponse } from "next/server";
import { getDatabase, moveFile, withLock } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { isAbsolute, join, resolve, sep } from "node:path";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * PATCH /api/files/[id]/move — rename or relocate a file.
 *
 * `new_path` must be absolute and resolve under either the file's owning
 * project (for reference files) or `<DATA_DIR>/knowledge` (for KB files).
 * Cross-project / cross-section moves are rejected so the watcher and the
 * project-vs-KB storage_type invariant don't get out of sync.
 */
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
  const newPath: unknown = body?.new_path;
  if (typeof newPath !== "string" || newPath.length === 0) {
    return NextResponse.json({ error: "new_path is required" }, { status: 400 });
  }
  if (newPath.includes("\0")) {
    return NextResponse.json({ error: "new_path contains null byte" }, { status: 400 });
  }
  if (!isAbsolute(newPath)) {
    return NextResponse.json({ error: "new_path must be absolute" }, { status: 400 });
  }

  const db = getDatabase();
  const file = db
    .prepare("SELECT id, path, project_id, storage_type FROM files WHERE id = ?")
    .get(n) as { id: number; path: string; project_id: number | null; storage_type: string } | undefined;
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

  let base: string;
  // repoDir MUST match commitFile's lock key: project path for ref, DATA_DIR for KB.
  let repoDir: string;
  if (file.storage_type === "reference" && file.project_id) {
    const project = db
      .prepare("SELECT path FROM projects WHERE id = ?")
      .get(file.project_id) as { path: string | null } | undefined;
    if (!project?.path) {
      return NextResponse.json({ error: `Project not found for file ${n}` }, { status: 400 });
    }
    base = project.path;
    repoDir = project.path;
  } else {
    base = join(DATA_DIR, "knowledge");
    repoDir = DATA_DIR;
  }

  const baseResolved = resolve(base);
  const destResolved = resolve(newPath);
  if (destResolved !== baseResolved && !destResolved.startsWith(baseResolved + sep)) {
    return NextResponse.json({ error: `new_path must be inside ${base}` }, { status: 400 });
  }
  const srcResolved = resolve(file.path);
  if (srcResolved !== baseResolved && !srcResolved.startsWith(baseResolved + sep)) {
    return NextResponse.json(
      { error: `source path ${file.path} is no longer inside ${base}; refusing to move` },
      { status: 400 }
    );
  }

  try {
    const updated = await withLock(`git:${resolve(repoDir)}`, async () => moveFile(n, newPath));
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to move file" }, { status: 500 });
  }
}
