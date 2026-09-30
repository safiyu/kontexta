import { NextRequest, NextResponse } from "next/server";
import { isAgentId, agentMeta, installMcp, uninstallMcp, detectInstallMode, MCP_APPROVALS, type McpApproval } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { mcpOpts, mcpDockerCommandFor } from "@/lib/agents-state";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureDbInitialized();
  const { id } = await params;
  if (!isAgentId(id)) return NextResponse.json({ error: `Unknown agent: ${id}` }, { status: 404 });

  let body: { action?: unknown; approval?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  const action = body?.action;
  if (action !== "install" && action !== "uninstall") return NextResponse.json({ error: "action must be 'install' or 'uninstall'" }, { status: 400 });
  const approval = (body?.approval ?? "prompt") as McpApproval;
  if (!MCP_APPROVALS.includes(approval)) return NextResponse.json({ error: `approval must be one of ${MCP_APPROVALS.join(", ")}` }, { status: 400 });
  if (!agentMeta(id)!.mcpInstallable) return NextResponse.json({ error: `${id} is not supported yet by the MCP installer; use the INSTALL tab snippet` }, { status: 400 });
  if (detectInstallMode() === "docker") {
    return NextResponse.json({ error: "MCP config lives on the host; run the docker command there.", mode: "docker", docker_command: mcpDockerCommandFor(id, action === "install" ? approval : undefined) }, { status: 409 });
  }
  const [outcome] = action === "install" ? installMcp([id], mcpOpts(approval)) : uninstallMcp([id], mcpOpts());
  return NextResponse.json({ agent: id, outcome });
}
