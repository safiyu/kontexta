import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getDatabase } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function projectPath(id: number): string | null {
  const row = getDatabase()
    .prepare("SELECT path FROM projects WHERE id = ?")
    .get(id) as { path: string | null } | undefined;
  return row?.path ?? null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { id } = await ctx.params;
  const n = parseId(id);
  if (n === null)
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const root = projectPath(n);
  if (!root)
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const file = join(root, "kontexta.json");
  if (!existsSync(file))
    return NextResponse.json({
      exists: false,
      journal: null,
      mtimeMs: null,
    });
  const raw = readFileSync(file, "utf8");
  const mtimeMs = statSync(file).mtimeMs;
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // malformed — treat as empty
  }
  return NextResponse.json({
    exists: true,
    journal: parsed.journal ?? null,
    mtimeMs,
  });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { id } = await ctx.params;
  const n = parseId(id);
  if (n === null)
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const root = projectPath(n);
  if (!root)
    return NextResponse.json({ error: "Project not found" }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("journal" in body)) {
    return NextResponse.json({ error: "missing journal field" }, { status: 400 });
  }

  const file = join(root, "kontexta.json");
  let current: any = { version: "1" };
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // keep default
    }
  }

  current.journal = body.journal;

  // Sweep stray *.tmp.* siblings from prior SIGKILLed writes — skip our own pid
  // and any tmp written within the last 60s (likely a concurrent in-flight PUT).
  const dir = dirname(file);
  const baseName = basename(file);
  const ownPidPrefix = `${baseName}.tmp.${process.pid}.`;
  const now = Date.now();
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`${baseName}.tmp.`)) continue;
      if (entry.startsWith(ownPidPrefix)) continue;
      try {
        const st = statSync(join(dir, entry));
        if (now - st.mtimeMs < 60_000) continue;
        unlinkSync(join(dir, entry));
      } catch {}
    }
  } catch {}

  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist if writeFileSync failed early */ }
    throw e;
  }
  return NextResponse.json({ ok: true, mtimeMs: statSync(file).mtimeMs });
}
