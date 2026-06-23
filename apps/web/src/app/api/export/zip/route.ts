import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import archiver from "archiver";
import { Readable } from "node:stream";
import { listFiles, readFile, getDatabase } from "kxta-core";
import { ensureDbInitialized, DATA_DIR } from "@/lib/db-init";
import { statSync } from "node:fs";
import { relative, basename, join } from "node:path";

function defaultMaxBytes(): number {
  const raw = process.env.KONTEXTA_EXPORT_MAX_BYTES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 100 * 1024 * 1024;
}

interface Entry { absolute_path: string; archive_path: string }

function getProjectPath(projectId: number): string | null {
  const db = getDatabase();
  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string | null } | undefined;
  return row?.path ?? null;
}

function getProjectSlug(projectId: number): string {
  const db = getDatabase();
  const row = db.prepare("SELECT slug FROM projects WHERE id = ?").get(projectId) as { slug: string } | undefined;
  return row?.slug ?? `project-${projectId}`;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const url = new URL(req.url);
  const fileIdsRaw = url.searchParams.get("file_ids");
  const folder = url.searchParams.get("folder");
  const projectIdRaw = url.searchParams.get("project_id");

  const modes = [fileIdsRaw, folder, projectIdRaw].filter((v) => v !== null && v !== "").length;
  // folder mode counts as a single mode but requires project_id alongside it; we
  // detect this combination explicitly below and don't double-count it.
  const isFolderMode = folder !== null && folder !== "" && projectIdRaw !== null && projectIdRaw !== "";
  const isFileIdsMode = fileIdsRaw !== null && fileIdsRaw !== "";
  const isProjectOnlyMode = !isFolderMode && projectIdRaw !== null && projectIdRaw !== "" && (folder === null || folder === "");
  const modesPicked = [isFileIdsMode, isFolderMode, isProjectOnlyMode].filter(Boolean).length;

  if (modesPicked === 0) {
    return NextResponse.json({ error: "must specify file_ids, folder+project_id, or project_id" }, { status: 400 });
  }
  if (modesPicked > 1) {
    return NextResponse.json({ error: "specify exactly one of file_ids, folder, project_id" }, { status: 400 });
  }

  const entries: Entry[] = [];
  let rootName = "kontexta-export";

  if (isFileIdsMode) {
    // Require an explicit scope so file_ids can't be used as a cross-project
    // arbitrary-file-read primitive. Caller must pass scope=kb or scope=N
    // (project id), and every file in the list must belong to that scope.
    const scope = url.searchParams.get("scope");
    if (!scope) {
      return NextResponse.json(
        { error: "file_ids requires scope=kb or scope=<project_id>" },
        { status: 400 }
      );
    }
    let scopeProjectId: number | null = null;
    if (scope !== "kb") {
      const n = Number(scope);
      if (!Number.isInteger(n) || n < 0) {
        return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
      }
      scopeProjectId = n;
      if (!getProjectPath(scopeProjectId)) {
        return NextResponse.json({ error: "Scope project not found" }, { status: 404 });
      }
    }
    const ids = fileIdsRaw!.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
    for (const id of ids) {
      try {
        const file = readFile(id);
        const fileProjectId = file.project_id ?? null;
        if (fileProjectId !== scopeProjectId) {
          // Silently drop files outside the declared scope rather than 403'ing,
          // so a single missing/moved row doesn't tank the whole export. The
          // returned archive only contains files matching the scope.
          continue;
        }
        let archive_path: string;
        if (file.project_id) {
          const projectPath = getProjectPath(file.project_id);
          archive_path = projectPath ? relative(projectPath, file.path) : basename(file.path);
        } else {
          archive_path = relative(join(DATA_DIR, "knowledge"), file.path);
        }
        entries.push({ absolute_path: file.path, archive_path });
      } catch {
        // skip missing
      }
    }
    rootName = `kontexta-export-${Date.now()}`;
  } else if (isProjectOnlyMode) {
    const pid = Number(projectIdRaw);
    if (!Number.isInteger(pid) || pid < 0) {
      return NextResponse.json({ error: "Invalid project_id" }, { status: 400 });
    }
    const projectPath = getProjectPath(pid);
    if (!projectPath) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const files = listFiles({ dataDir: DATA_DIR, filters: { project_id: pid } });
    for (const f of files) {
      entries.push({ absolute_path: f.path, archive_path: relative(projectPath, f.path) });
    }
    rootName = getProjectSlug(pid);
  } else if (isFolderMode) {
    const pid = Number(projectIdRaw);
    if (!Number.isInteger(pid) || pid < 0) {
      return NextResponse.json({ error: "Invalid project_id" }, { status: 400 });
    }
    // Reject path-traversal in folder query param. listFiles is DB-scoped so
    // it can't actually escape, but a `..` segment would produce ZIP entries
    // with `../` paths that some clients silently accept.
    if (folder!.split(/[/\\]/).some((seg) => seg === "..") || folder!.startsWith("/") || folder!.startsWith("\\")) {
      return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
    }
    const projectPath = getProjectPath(pid);
    if (!projectPath) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const files = listFiles({ dataDir: DATA_DIR, filters: { project_id: pid, folder: folder! } });
    const folderRoot = join(projectPath, folder!);
    for (const f of files) {
      entries.push({ absolute_path: f.path, archive_path: relative(folderRoot, f.path) });
    }
    rootName = basename(folder!) || "folder";
  }

  if (entries.length === 0) {
    return NextResponse.json({ error: "no files to export" }, { status: 404 });
  }

  // Size cap (best-effort: stat files; missing files are dropped silently here too).
  let total = 0;
  const cap = defaultMaxBytes();
  const live: Entry[] = [];
  for (const e of entries) {
    try {
      total += statSync(e.absolute_path).size;
      live.push(e);
    } catch {}
  }
  if (total > cap) {
    return NextResponse.json({ error: "export too large" }, { status: 413 });
  }
  if (live.length === 0) {
    return NextResponse.json({ error: "no files to export" }, { status: 404 });
  }

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("export/zip archiver error:", err);
    archive.destroy();
  });
  // Track streamed bytes against the cap. Files can grow between stat and
  // archive-read; without this the client gets a half-stream with no signal.
  let streamed = 0;
  let truncated = false;
  archive.on("data", (chunk: Buffer) => {
    streamed += chunk.length;
    if (!truncated && streamed > cap) {
      truncated = true;
      console.warn(`[export/zip] aborting: streamed=${streamed} > cap=${cap}`);
      archive.abort();
    }
  });
  if (req.signal) {
    req.signal.addEventListener("abort", () => archive.destroy(), { once: true });
  }
  for (const e of live) {
    archive.file(e.absolute_path, { name: e.archive_path });
  }
  archive.finalize();

  // Convert Node Readable into a Web ReadableStream for the Response body.
  const webStream = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;

  const safeRoot = rootName.replace(/[^A-Za-z0-9._-]/g, "_") || "export";
  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeRoot}.zip"`,
      "X-Export-Cap-Bytes": String(cap),
    },
  });
}
