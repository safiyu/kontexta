import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { syncAgentRules, getDatabase, type AgentId } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { join } from "node:path";

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
  if (project_id != null && project_id !== "" && Number(project_id) > 0) {
    const db = getDatabase();
    const project = db
      .prepare("SELECT id, name, path FROM projects WHERE id = ?")
      .get(Number(project_id)) as { id: number; name: string; path: string | null } | undefined;
    if (!project || !project.path) {
      return NextResponse.json({ error: `Project ${project_id} not found or has no path` }, { status: 404 });
    }
    projectPath = project.path;
    projectName = project.name;
  } else {
    // For KB-only mode or fresh installs without projects yet, onboard into the Knowledge Base root
    projectPath = join(DATA_DIR, "knowledge");
    projectName = "Knowledge Base";
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
