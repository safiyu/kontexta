import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { listProjects, registerProject, discoverFiles } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const projects = listProjects();
  const augmented = projects.map((p) => ({
    ...p,
    has_hands: !!(p.path && existsSync(`${p.path}/kontexta.json`)),
  }));
  return NextResponse.json(augmented);
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { name, path, description } = body ?? {};
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
    return NextResponse.json({ error: "name must be a non-empty string (<=200 chars)" }, { status: 400 });
  }
  if (typeof path !== "string" || path.length === 0) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (!isAbsolute(path)) {
    return NextResponse.json({ error: "path must be absolute" }, { status: 400 });
  }
  if (path.includes("\0")) {
    return NextResponse.json({ error: "path contains null byte" }, { status: 400 });
  }
  if (!existsSync(path)) {
    return NextResponse.json({ error: `path does not exist: ${path}` }, { status: 400 });
  }
  try {
    if (!statSync(path).isDirectory()) {
      return NextResponse.json({ error: "path must be a directory" }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: `cannot stat path: ${e?.message ?? e}` }, { status: 400 });
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    return NextResponse.json({ error: "description must be a string" }, { status: 400 });
  }

  try {
    const project = registerProject(name, path, description ?? undefined);
    let discoveredCount = 0;
    let totalEstTokens = 0;
    try {
      const discoveredFiles = discoverFiles(project.id, DATA_DIR);
      discoveredCount = discoveredFiles.length;
      // est_tokens isn't computed by core's discoverFiles; approximate from
      // content_hash-less rows by re-reading via stat would be expensive at
      // register time. Instead, use the file size on disk / 4 as a cheap
      // upper-bound estimate (matches the ASCII-heavy heuristic used elsewhere).
      for (const f of discoveredFiles) {
        try {
          const sz = statSync(f.path).size;
          totalEstTokens += Math.max(1, Math.ceil(sz / 4));
        } catch {}
      }
    } catch (e: any) {
      // Surface as a soft warning — registration succeeded even if scan failed.
      console.warn(`registerProject succeeded but discoverFiles failed:`, e);
      return NextResponse.json(
        { project, discovered_files: 0, warning: `Initial scan failed: ${e?.message ?? e}` },
        { status: 201 }
      );
    }
    const tokenWarn = Number(process.env.KONTEXTA_PROJECT_TOKEN_WARN ?? 100_000);
    const sizeWarning =
      Number.isFinite(tokenWarn) && tokenWarn > 0 && totalEstTokens > tokenWarn
        ? `Project content totals ~${totalEstTokens.toLocaleString()} tokens, above the ${tokenWarn.toLocaleString()}-token soft cap. Consider adding ignore patterns or scoping by folder before pulling into an AI session.`
        : null;
    return NextResponse.json(
      {
        project,
        discovered_files: discoveredCount,
        total_est_tokens: totalEstTokens,
        ...(sizeWarning ? { warning: sizeWarning } : {}),
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("registerProject failed:", error);
    const status = error?.code === "PROJECT_CONFLICT" ? 409 : 400;
    return NextResponse.json({ error: error?.message ?? "Failed to register project" }, { status });
  }
}
