import { NextRequest, NextResponse } from "next/server";
import { restoreVersion, readFile, getDatabase } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  ensureDbInitialized();
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { hash } = body ?? {};

  if (!hash || typeof hash !== "string" || !/^[0-9a-f]{7,40}$/i.test(hash)) {
    return NextResponse.json({ error: "Valid commit hash is required" }, { status: 400 });
  }

  try {
    const file = readFile(n);
    if (!file || !file.path) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    let repoDir = DATA_DIR;
    if (file.storage_type === "reference" && file.project_id) {
      const db = getDatabase();
      const project = db
        .prepare("SELECT path FROM projects WHERE id = ?")
        .get(file.project_id) as { path: string | null } | undefined;
      if (project?.path) repoDir = project.path;
    }

    const content = await restoreVersion(repoDir, file.path, hash);
    return NextResponse.json({ success: true, content });
  } catch (error) {
    console.error("Failed to restore version:", error);
    return NextResponse.json({ error: "Failed to restore version" }, { status: 500 });
  }
}
