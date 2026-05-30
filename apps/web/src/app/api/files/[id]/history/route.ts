import { NextRequest, NextResponse } from "next/server";
import { getHistory, readFile, getDatabase } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  ensureDbInitialized();
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
  }
  try {
    const file = readFile(n);
    if (!file || !file.path) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Reference files (external project files) live in the project's own
    // git repo, not the global data dir. Use the right one or history
    // returns nothing for project files.
    let repoDir = DATA_DIR;
    if (file.storage_type === "reference" && file.project_id) {
      const db = getDatabase();
      const project = db
        .prepare("SELECT path FROM projects WHERE id = ?")
        .get(file.project_id) as { path: string | null } | undefined;
      if (project?.path) repoDir = project.path;
    }

    const history = await getHistory(repoDir, file.path);
    return NextResponse.json(history);
  } catch (error) {
    console.error("Failed to fetch history:", error);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}
