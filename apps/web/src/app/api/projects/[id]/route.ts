import { NextRequest, NextResponse } from "next/server";
import { getDatabase, unregisterProject, isValidGitRemoteUrl, withLock } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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
    if (body.path.includes("\0")) {
      return NextResponse.json({ error: "path contains null byte" }, { status: 400 });
    }
    if (!isAbsolute(body.path)) {
      return NextResponse.json({ error: "path must be absolute" }, { status: 400 });
    }
    if (!existsSync(body.path)) {
      return NextResponse.json({ error: `path does not exist: ${body.path}` }, { status: 400 });
    }
    try {
      if (!statSync(body.path).isDirectory()) {
        return NextResponse.json({ error: "path must be a directory" }, { status: 400 });
      }
    } catch (e: any) {
      return NextResponse.json({ error: `cannot stat path: ${e?.message ?? e}` }, { status: 400 });
    }

    const oldRow = db.prepare("SELECT path FROM projects WHERE id = ?").get(n) as { path: string | null };
    const oldBase = oldRow?.path ? resolve(oldRow.path) : null;
    const newBase = resolve(body.path);

    // Hold the same git lock commitFile uses on the OLD project path so a
    // concurrent reference-file commit can't land at the old path while we
    // rewrite rows to point at the new path (DB/git divergence). After the
    // swap, future commitFile calls will lock on the new path.
    const runRewrite = () => {
      db.transaction(() => {
        db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(body.path, n);
        // Rewrite each row's path prefix so file ids (and the tags/favorites
        // joined to them) survive the move.
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
    };
    if (oldBase) {
      await withLock(`git:${oldBase}`, async () => runRewrite());
    } else {
      runRewrite();
    }
  }

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(n);
  return NextResponse.json(project);
}
