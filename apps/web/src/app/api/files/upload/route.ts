import { NextRequest, NextResponse } from "next/server";
import { createFile, listFiles, slugify } from "kxta-core";
import { ensureDbInitialized, DATA_DIR } from "@/lib/db-init";
import { basename, extname, dirname } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = Number(process.env.KONTEXTA_UPLOAD_MAX_TOTAL_BYTES ?? 50 * 1024 * 1024);
const MAX_FILES = Number(process.env.KONTEXTA_UPLOAD_MAX_FILES ?? 200);
const ALLOWED_EXT = new Set([".md", ".markdown", ".mmd"]);

interface UploadedItem {
  id: number;
  path: string;
  original_name: string;
  final_name: string;
}
interface RejectedItem { name: string; reason: string }

function nextAvailableName(existingBasenames: Set<string>, desired: string): string {
  if (!existingBasenames.has(desired)) return desired;
  const ext = extname(desired);
  const stem = desired.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existingBasenames.has(candidate)) return candidate;
  }
  // Fall back to timestamp if 1000 collisions (effectively impossible).
  return `${stem}-${Date.now()}${ext}`;
}

export async function POST(req: NextRequest) {
  ensureDbInitialized();

  // Reject obviously oversized uploads BEFORE Next's formData parser
  // buffers the whole multipart body into memory. The body-level total
  // includes multipart boundaries/headers so allow ~1MB of slack on
  // top of MAX_TOTAL_BYTES; per-file checks below still apply.
  const contentLengthRaw = req.headers.get("content-length");
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES + 1024 * 1024) {
      return NextResponse.json(
        { error: `Upload body ${contentLength} bytes exceeds cap ${MAX_TOTAL_BYTES}` },
        { status: 413 }
      );
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Body must be multipart/form-data" }, { status: 400 });
  }

  const projectIdRaw = form.get("project_id");
  const folder = (form.get("folder") as string | null) ?? "";
  const tagsRaw = form.get("tags") as string | null;
  const files = form.getAll("files").filter((v): v is File => v instanceof File);

  // Validate folder shape. Without this, leading/trailing slashes or
  // ".." segments make the dirname-suffix collision check below silently
  // miss neighbors, allowing two uploads with the same final basename to
  // both succeed and silently overwrite one another on disk.
  if (folder) {
    if (folder.includes("\0")) {
      return NextResponse.json({ error: "folder contains null byte" }, { status: 400 });
    }
    if (folder.startsWith("/") || folder.startsWith("\\") || folder.endsWith("/") || folder.endsWith("\\")) {
      return NextResponse.json({ error: "folder must not start or end with a path separator" }, { status: 400 });
    }
    const segs = folder.split(/[\/\\]/);
    if (segs.some((s) => s === "" || s === "." || s === "..")) {
      return NextResponse.json({ error: "folder must not contain empty, '.' or '..' segments" }, { status: 400 });
    }
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES})` },
      { status: 413 }
    );
  }
  // Pre-flight total-size check using the multipart-reported sizes; cheap
  // and avoids buffering 1000×4.9MB into memory before we notice.
  const declaredTotal = files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (declaredTotal > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: `Total upload size ${declaredTotal} exceeds cap ${MAX_TOTAL_BYTES}` },
      { status: 413 }
    );
  }

  let projectId: number | undefined;
  if (typeof projectIdRaw === "string" && projectIdRaw !== "") {
    const n = Number(projectIdRaw);
    // SQLite AUTOINCREMENT starts at 1; reject 0 explicitly so it doesn't fall
    // through the truthy `projectId ? "project" : "knowledge"` check below.
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: "Invalid project_id" }, { status: 400 });
    }
    projectId = n;
  }

  let tags: string[] | undefined;
  if (tagsRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(tagsRaw);
    } catch {
      return NextResponse.json({ error: "tags must be a JSON array of strings" }, { status: 400 });
    }
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
      return NextResponse.json({ error: "tags must be a JSON array of strings" }, { status: 400 });
    }
    tags = parsed as string[];
  }

  const destination = projectId ? "project" : "knowledge";

  // Collision avoidance must compare against the actual on-disk filename
  // createFile will produce — that's `slugify(stem) + ".md"`, NOT the
  // original upload name. Otherwise `Auth Notes.md` and `auth-notes.md`
  // both slug to `auth-notes.md` and clobber each other while the
  // response dishonestly reports success.
  // Also scope to the destination directory only (same `folder`), not the
  // entire project — `notes.md` in folder A shouldn't conflict with one in B.
  const existing = listFiles({
    dataDir: DATA_DIR,
    filters: { project_id: projectId ?? null, folder: folder || undefined },
  });
  const existingBasenames = new Set<string>(
    existing
      .filter((f) => {
        // listFiles' folder filter is path-segment LIKE, which can match
        // nested subfolders. Restrict to the exact destination directory
        // by comparing the file's dirname.
        if (!folder) return true; // root: include all of this scope
        const dir = dirname(f.path);
        return dir.endsWith("/" + folder) || dir.endsWith("\\" + folder) || dir === folder;
      })
      .map((f) => basename(f.path))
  );

  const uploaded: UploadedItem[] = [];
  const rejected: RejectedItem[] = [];
  let runningTotal = 0;

  for (const file of files) {
    const original = file.name;
    const ext = extname(original).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      rejected.push({ name: original, reason: "unsupported_extension" });
      continue;
    }
    if (file.size > MAX_BYTES) {
      rejected.push({ name: original, reason: "too_large" });
      continue;
    }
    // Belt-and-suspenders: declared sizes can lie. Track post-read totals.
    if (runningTotal + file.size > MAX_TOTAL_BYTES) {
      rejected.push({ name: original, reason: "total_cap_exceeded" });
      continue;
    }
    runningTotal += file.size;

    // Compute the on-disk basename createFile will actually use, then
    // pick a non-colliding stem. We hand createFile a *title* that will
    // re-slugify back to the same basename so what we promised matches
    // what gets written.
    const originalStem = original.slice(0, -ext.length);
    const slugStem = slugify(originalStem) || "untitled";
    const desiredBasename = `${slugStem}${ext}`;
    const finalBasename = nextAvailableName(existingBasenames, desiredBasename);
    existingBasenames.add(finalBasename);

    const buf = new Uint8Array(await file.arrayBuffer());
    let content: string;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      content = new TextDecoder("utf-16le").decode(buf.subarray(2));
    } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      content = new TextDecoder("utf-16be").decode(buf.subarray(2));
    } else {
      const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(start));
      } catch {
        rejected.push({ name: original, reason: "unsupported_encoding" });
        continue;
      }
    }
    // Strip the extension and trailing collision-avoidance suffix to
    // recover a title that re-slugifies back to finalBasename's stem.
    const finalStem = finalBasename.slice(0, -extname(finalBasename).length);

    try {
      const created = await createFile({
        title: finalStem,
        content,
        destination,
        projectId,
        folder: folder || undefined,
        tags,
        dataDir: DATA_DIR,
      });
      uploaded.push({ id: created.id, path: created.path, original_name: original, final_name: finalBasename });
    } catch (e: any) {
      rejected.push({ name: original, reason: `create_failed: ${e?.message ?? String(e)}` });
    }
  }

  return NextResponse.json({ uploaded, rejected });
}
