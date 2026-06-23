import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { syncAgentRules, getDatabase, type AgentId } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { agent, project_id } = body ?? {};

  if (!agent || typeof agent !== "string") {
    return NextResponse.json({ error: "agent is required" }, { status: 400 });
  }

  // Resolve project path
  let projectPath: string | null = null;
  let projectName = "";
  if (project_id != null) {
    const db = getDatabase();
    const project = db
      .prepare("SELECT id, name, path FROM projects WHERE id = ?")
      .get(project_id) as { id: number; name: string; path: string | null } | undefined;
    if (!project || !project.path) {
      return NextResponse.json({ error: `Project ${project_id} not found or has no path` }, { status: 404 });
    }
    projectPath = project.path;
    projectName = project.name;
  }

  // For KB-only mode (no project), we can't onboard — need a project path
  if (!projectPath) {
    return NextResponse.json({ error: "project_id is required for onboarding" }, { status: 400 });
  }

  try {
    const result = syncAgentRules({
      projectPath,
      project: { name: projectName, description: null },
      files: [],
      targetAgent: agent as AgentId,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("onboard failed:", error);
    return NextResponse.json({ error: error?.message ?? "Failed to onboard agent" }, { status: 500 });
  }
}
