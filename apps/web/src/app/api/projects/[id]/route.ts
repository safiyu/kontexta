import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getDatabase, unregisterProject, isValidGitRemoteUrl, withLock } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { assertSafeUserPath } from "@/lib/safe-path";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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
    unregisterProject(n, DATA_DIR);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to unregister" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

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
  const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(n);
  if (!existing) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  if (body.remote_url !== undefined) {
    if (body.remote_url === null || body.remote_url === "") {
      db.prepare("UPDATE projects SET remote_url = NULL WHERE id = ?").run(n);
    } else if (typeof body.remote_url !== "string") {
      return NextResponse.json({ error: "remote_url must be a string" }, { status: 400 });
    } else if (!isValidGitRemoteUrl(body.remote_url)) {
      return NextResponse.json(
        { error: "Invalid remote URL: must be https://, ssh://, git://, or user@host:path" },
        { status: 400 }
      );
    } else {
      db.prepare("UPDATE projects SET remote_url = ? WHERE id = ?").run(body.remote_url, n);
    }
  }

  // Allow updating the on-disk path of a project (e.g. user moved/renamed
  // the directory). Without this, the only recovery is unregister +
  // re-register, which destroys all tags/favorites attached by file id.
  // We rewrite every files.path that lives under the old path so existing
  // rows survive the move.
  if (body.path !== undefined) {
    if (typeof body.path !== "string" || body.path.length === 0) {
      return NextResponse.json({ error: "path must be a non-empty string" }, { status: 400 });
    }
    let canonicalNewPath: string;
    try {
      canonicalNewPath = assertSafeUserPath(body.path);
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? "Invalid path" }, { status: 400 });
    }
    if (!existsSync(canonicalNewPath)) {
      return NextResponse.json({ error: `path does not exist: ${body.path}` }, { status: 400 });
    }
    try {
      if (!statSync(canonicalNewPath).isDirectory()) {
        return NextResponse.json({ error: "path must be a directory" }, { status: 400 });
      }
    } catch (e: any) {
      return NextResponse.json({ error: `cannot stat path: ${e?.message ?? e}` }, { status: 400 });
    }

    const oldRow = db.prepare("SELECT path FROM projects WHERE id = ?").get(n) as { path: string | null };
    const oldBase = oldRow?.path ? resolve(oldRow.path) : null;
    const newBase = canonicalNewPath;

    // Hold the same git lock commitFile uses on the OLD project path so a
    // concurrent reference-file commit can't land at the old path while we
    // rewrite rows to point at the new path (DB/git divergence). After the
    // swap, future commitFile calls will lock on the new path.
    //
    // The pre-flight `missing[]` check is INSIDE the lock so a concurrent
    // filesystem operation can't unlink the target between the check and the
    // DB rewrite (previously a TOCTOU window).
    const runRewriteWithChecks = (): NextResponse | null => {
      if (oldBase && oldBase !== newBase) {
        const oldPrefix = oldBase.endsWith(sep) ? oldBase : oldBase + sep;
        const newPrefix = newBase.endsWith(sep) ? newBase : newBase + sep;
        const rows = db
          .prepare("SELECT id, path FROM files WHERE project_id = ?")
          .all(n) as { id: number; path: string }[];
        const missing: string[] = [];
        for (const r of rows) {
          let target: string | null = null;
          if (r.path === oldBase) target = newBase;
          else if (r.path.startsWith(oldPrefix)) target = newPrefix + r.path.slice(oldPrefix.length);
          if (target && !existsSync(target)) missing.push(target);
        }
        if (missing.length > 0) {
          return NextResponse.json(
            {
              error: `Refusing to rewrite paths: ${missing.length} file(s) missing under new base. First: ${missing[0]}`,
              missing_count: missing.length,
              sample: missing.slice(0, 5),
            },
            { status: 409 }
          );
        }
      }
      db.transaction(() => {
        db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(canonicalNewPath, n);
        if (oldBase && oldBase !== newBase) {
          const oldPrefix = oldBase.endsWith(sep) ? oldBase : oldBase + sep;
          const newPrefix = newBase.endsWith(sep) ? newBase : newBase + sep;
          const rows = db
            .prepare("SELECT id, path FROM files WHERE project_id = ?")
            .all(n) as { id: number; path: string }[];
          const upd = db.prepare("UPDATE files SET path = ? WHERE id = ?");
          for (const r of rows) {
            if (r.path === oldBase) {
              upd.run(newBase, r.id);
            } else if (r.path.startsWith(oldPrefix)) {
              upd.run(newPrefix + r.path.slice(oldPrefix.length), r.id);
            }
          }
        }
      })();
      return null;
    };
    let earlyExit: NextResponse | null = null;
    if (oldBase) {
      earlyExit = await withLock(`git:${oldBase}`, async () => runRewriteWithChecks());
    } else {
      earlyExit = runRewriteWithChecks();
    }
    if (earlyExit) return earlyExit;
  }

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(n);
  return NextResponse.json(project);
}
