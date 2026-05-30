import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { renderTemplate, CLIENTS, INSTALLS, type Client, type Install } from "@/lib/install-templates";

let cachedSourceEntrypoint: string | null = null;
function resolveSourceEntrypoint(): string {
  if (cachedSourceEntrypoint) return cachedSourceEntrypoint;
  // In Docker the MCP server is deployed separately to /app/apps/mcp and is
  // not resolvable from the standalone web bundle's node_modules graph.
  const inDocker =
    process.env.KONTEXTA_INSTALL_HINT === "docker" ||
    (() => { try { return existsSync("/.dockerenv"); } catch { return false; } })();
  if (inDocker) {
    cachedSourceEntrypoint = "/app/apps/mcp/dist/index.js";
    return cachedSourceEntrypoint;
  }
  try {
    cachedSourceEntrypoint = createRequire(import.meta.url).resolve("kontexta-mcp");
    return cachedSourceEntrypoint;
  } catch {
    return "/path/to/kontexta-mcp/dist/index.js";
  }
}

let cachedVersion: string | null = null;
function loadVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    cachedVersion = String(pkg.version ?? "latest");
  } catch {
    cachedVersion = "latest";
  }
  return cachedVersion;
}

function detectInstall(): Install {
  if (process.env.KONTEXTA_INSTALL_HINT === "docker") return "docker";
  if (process.env.KONTEXTA_INSTALL_HINT === "npm") return "npm";
  if (process.env.KONTEXTA_INSTALL_HINT === "source") return "source";
  try {
    if (existsSync("/.dockerenv")) return "docker";
  } catch {}
  if (process.env.npm_execpath?.includes("npx")) return "npm";
  return "source";
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const client = sp.get("client") as Client | null;
  const install = sp.get("install") as Install | null;
  if (!client || !CLIENTS.includes(client)) {
    return NextResponse.json({ error: "invalid client" }, { status: 400 });
  }
  if (!install || !INSTALLS.includes(install)) {
    return NextResponse.json({ error: "invalid install" }, { status: 400 });
  }
  const vars = {
    dataDir: process.env.KONTEXTA_DATA_DIR ?? "/path/to/your/data",
    version: loadVersion(),
    sourceEntrypoint: resolveSourceEntrypoint(),
  };
  const snippet = renderTemplate(client, install, vars);
  return NextResponse.json({
    ...snippet,
    detectedInstall: detectInstall(),
  });
}
