import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { getDatabase, syncAgentRules, type AgentId } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { id } = await params;
  const n = parseId(id);
  if (n === null) return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });

  let body: { targetAgent?: string; files?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const db = getDatabase();
  const project = db.prepare("SELECT id, name, path FROM projects WHERE id = ?").get(n) as { id: number; name: string; path: string } | undefined;
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  try {
    const result = syncAgentRules({
      projectPath: project.path,
      project: { name: project.name },
      files: body.files ?? [],
      targetAgent: body.targetAgent as AgentId,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Onboarding failed" }, { status: 500 });
  }
}
