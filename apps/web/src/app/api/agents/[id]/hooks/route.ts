import { NextRequest, NextResponse } from "next/server";
import { isAgentId, agentMeta, installHooks, uninstallHooks, detectInstallMode } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { installOpts, dockerCommandFor } from "@/lib/agents-state";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureDbInitialized();
  const { id } = await params;
  if (!isAgentId(id)) return NextResponse.json({ error: `Unknown agent: ${id}` }, { status: 404 });

  let body: { action?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  const action = body?.action;
  if (action !== "install" && action !== "uninstall") return NextResponse.json({ error: "action must be 'install' or 'uninstall'" }, { status: 400 });
  if (!agentMeta(id)!.hooksSupported) return NextResponse.json({ error: `${id} does not support hooks (MCP capture only)` }, { status: 400 });
  if (detectInstallMode() === "docker") {
    return NextResponse.json({ error: "Hooks live on the host; run the docker command there.", mode: "docker", docker_command: dockerCommandFor(id) }, { status: 409 });
  }
  const [outcome] = action === "install" ? installHooks([id], installOpts()) : uninstallHooks([id], installOpts());
  return NextResponse.json({ agent: id, outcome });
}
