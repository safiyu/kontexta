import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { createFolder, getDatabase, listProjectFolders } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { join } from "node:path";

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { projectId, name } = (body as { projectId?: unknown; name?: unknown }) ?? {};

  if (typeof name !== "string" || name.length === 0) {
    return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
  }
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0)
  ) {
    // Reject 0 explicitly — SQLite ids start at 1, and the `if (projectId)`
    // truthy check below would otherwise route 0 silently to the KB branch.
    return NextResponse.json({ error: "projectId must be a positive integer (omit or send null for the knowledge base)" }, { status: 400 });
  }
  // Reject obvious traversal before passing to filesystem code; createFolder
  // calls assertPathInside as a backstop.
  if (
    name.includes("\0") ||
    name.startsWith("/") || name.startsWith("\\") ||
    name.split(/[/\\]/).some((seg) => seg === "..")
  ) {
    return NextResponse.json({ error: "Invalid folder name" }, { status: 400 });
  }

  const db = getDatabase();
  let projectPath: string;

  if (projectId) {
    const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
    if (!project || !project.path) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    projectPath = project.path;
  } else {
    projectPath = join(DATA_DIR, "knowledge");
  }
  try {
    const path = createFolder(projectPath, name);
    return NextResponse.json({ path });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Invalid folder name" }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const db = getDatabase();

  let projectPath: string;

  if (projectId) {
    const projectIdNum = Number(projectId);
    if (!Number.isInteger(projectIdNum) || projectIdNum <= 0) {
      return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
    }
    const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectIdNum) as { path: string } | undefined;
    if (!project || !project.path) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    projectPath = project.path;
  } else {
    projectPath = join(DATA_DIR, "knowledge");
  }

  const folders = listProjectFolders(projectPath);
  return NextResponse.json({ folders, basePath: projectPath });
}


export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const folderName = searchParams.get("name");

  if (!folderName) {
    return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
  }

  const db = getDatabase();
  let projectPath: string;

  // Coerce projectId to a number; treat "null"/missing/non-numeric as "no project".
  const projectIdNum =
    projectId && projectId !== "null" && Number.isInteger(Number(projectId)) && Number(projectId) > 0
      ? Number(projectId)
      : null;

  if (projectIdNum !== null) {
    const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectIdNum) as { path: string } | undefined;
    if (!project || !project.path) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    projectPath = project.path;
  } else {
    projectPath = join(DATA_DIR, "knowledge");
  }

  try {
    const { deleteFolder } = await import("kxta-core");

    if (projectIdNum === null) {
      // KB folder — safe to delete from disk.
      deleteFolder(projectPath, folderName);
    } else {
      // Project folder — refuse. Un-indexing alone was a no-op: the
      // watcher (or the next "Scan for New Files") would re-ingest every
      // .md under the folder seconds later, making the deletion appear
      // to succeed and then silently revert. Until we have a persistent
      // ignore-list, the only honest answer is to disallow the action.
      return NextResponse.json(
        { error: "Cannot delete folders inside an external project. Use 'Unregister' to remove the whole project, or remove files from disk in your editor." },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Failed to delete folder:", error);
    return NextResponse.json({ 
      error: error.code === "ENOTEMPTY" ? "Folder is not empty" : "Failed to delete folder" 
    }, { status: 400 });
  }
}

