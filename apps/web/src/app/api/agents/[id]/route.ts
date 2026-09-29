import { NextRequest, NextResponse } from "next/server";
import { isAgentId, agentMeta, setEnabled, installHooks, detectInstallMode } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { installOpts, dockerCommandFor } from "@/lib/agents-state";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureDbInitialized();
  const { id } = await params;
  if (!isAgentId(id)) return NextResponse.json({ error: `Unknown agent: ${id}` }, { status: 404 });

  let body: { enabled?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });

  setEnabled(id, body.enabled);
  const meta = agentMeta(id)!;
  let install = null;
  let docker_command: string | null = null;
  let note: string | null = null;
  if (body.enabled) {
    if (!meta.hooksSupported) note = `${meta.name} has no hook API — MCP capture only.`;
    else if (detectInstallMode() === "docker") docker_command = dockerCommandFor(id);
    else install = installHooks([id], installOpts())[0];
  }
  return NextResponse.json({ agent: id, enabled: body.enabled, install, docker_command, note });
}
