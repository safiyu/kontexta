import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { renderTemplate, CLIENTS, INSTALLS, type Client, type Install } from "@/lib/install-templates";
import { DATA_DIR } from "@/lib/db-init";

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
    const pkgName = ["kontexta", "mcp"].join("-");
    cachedSourceEntrypoint = createRequire(import.meta.url).resolve(pkgName);
    return cachedSourceEntrypoint;
  } catch {
    // Fallback to relative path in monorepo structure
    // This resolves to apps/mcp/dist/index.js from the workspace root
    return path.resolve(process.cwd(), "..", "mcp", "dist", "index.js");
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

/** OS-standard data directory for the current platform (mirrors core's defaultDataDir). */
function osDefaultDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin": return path.join(home, "Library", "Application Support", "kontexta");
    case "win32":  return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "kontexta");
    default:       return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "kontexta");
  }
}

/** Human-readable tilde-abbreviated version of the OS default dir. */
function osDefaultDataDirDisplay(): string {
  const full = osDefaultDataDir();
  const home = os.homedir();
  return full.startsWith(home) ? `~${full.slice(home.length)}` : full;
}

/** True when the resolved dataDir looks like a temp/test path — never show these in snippets. */
function isTempPath(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    lower.startsWith("/tmp") ||
    lower.startsWith(os.tmpdir().toLowerCase()) ||
    lower.includes("test") ||
    lower.includes("-tmp-") ||
    lower.includes("\\temp")
  );
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const client = sp.get("client") as Client | null;
  const install = sp.get("install") as Install | null;
  if (!client || !CLIENTS.includes(client)) {
    console.log("Invalid client requested:", client, "Available:", CLIENTS);
    return NextResponse.json({ error: "invalid client" }, { status: 400 });
  }
  if (!install || !INSTALLS.includes(install)) {
    return NextResponse.json({ error: "invalid install" }, { status: 400 });
  }

  const defaultDir = osDefaultDataDir();
  const defaultDirDisplay = osDefaultDataDirDisplay();
  // Sanitize: never surface temp/test paths in install snippets.
  // If the running server resolved a temp path (e.g. from a dev test run),
  // fall back to the OS standard so the snippet stays useful.
  const rawDataDir = DATA_DIR;
  const dataDir = isTempPath(rawDataDir) ? defaultDir : rawDataDir;
  const isDefaultDir = path.resolve(dataDir) === path.resolve(defaultDir);

  const vars = {
    dataDir,
    hostDataDir: process.env.KONTEXTA_HOST_DATA_DIR ?? null,
    version: loadVersion(),
    sourceEntrypoint: resolveSourceEntrypoint(),
    isDefaultDir,
    defaultDirDisplay,
  };
  const snippet = renderTemplate(client, install, vars);
  return NextResponse.json({
    ...snippet,
    detectedInstall: detectInstall(),
    dataDir,
    isDefaultDir,
    defaultDirDisplay,
  });
}
