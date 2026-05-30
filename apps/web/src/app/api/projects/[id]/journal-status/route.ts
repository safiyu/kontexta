import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { readHighWater, openTasksForProject, getDatabase } from "kxta-core";
import { ensureDbInitialized, DATA_DIR } from "@/lib/db-init";
import { join } from "node:path";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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
  const db = getDatabase();
  const project = db
    .prepare("SELECT slug FROM projects WHERE id = ?")
    .get(n) as { slug: string } | undefined;
  if (!project)
    return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const hw = readHighWater(join(DATA_DIR, "knowledge", "journal"), project.slug);
  const open = openTasksForProject(n, 90);

  return NextResponse.json({
    slug: project.slug,
    high_water: hw,
    open_tasks_count: open.length,
    open_tasks: open.slice(0, 20).map((t) => ({
      task_slug: t.task_slug,
      last_active_at: t.last_active_at,
      status_latest: t.status_latest,
    })),
  });
}
