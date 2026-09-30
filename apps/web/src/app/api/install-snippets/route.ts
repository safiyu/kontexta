import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { renderTemplate, CLIENTS, INSTALLS, type Client, type Install, type Snippet } from "@/lib/install-templates";
import { DATA_DIR } from "@/lib/db-init";
import { resolveManualEntrypoint } from "@/lib/manual-entrypoint";
// kxta-core is server-external so os.homedir()/APPDATA reads never get bundled into a Windows-breaking nft glob.
import { defaultDataDir, defaultDataDirDisplay, detectInstallMode } from "kxta-core";

function manualNotFoundSnippet(): Snippet {
  return {
    kind: "shell",
    body: "# No manual/source install detected.\n# Run ./bootstrap (macOS/Linux) or .\\bootstrap.ps1 (Windows) from your\n# kontexta checkout, then reload this page.",
    notes: ["Manual install requires running the bootstrap script once from a cloned kontexta repository."],
  };
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

/** True when the resolved dataDir looks like a temp/test path: never show these in snippets. */
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

  const defaultDir = defaultDataDir();
  const defaultDirDisplay = defaultDataDirDisplay();
  // Never surface a temp/test dataDir (e.g. from a dev test run): fall back to the OS default instead.
  const rawDataDir = DATA_DIR;
  const dataDir = isTempPath(rawDataDir) ? defaultDir : rawDataDir;
  const isDefaultDir = path.resolve(dataDir) === path.resolve(defaultDir);

  const manualEntrypoint = install === "source" ? resolveManualEntrypoint() : null;
  const snippet =
    install === "source" && !manualEntrypoint
      ? manualNotFoundSnippet()
      : renderTemplate(client, install, {
          dataDir,
          hostDataDir: process.env.KONTEXTA_HOST_DATA_DIR ?? null,
          version: loadVersion(),
          sourceEntrypoint: manualEntrypoint ?? "",
          isDefaultDir,
          defaultDirDisplay,
          hasLocalCliMcp: process.env.KONTEXTA_INSTALL_HINT === "npm",
        });
  return NextResponse.json({
    ...snippet,
    detectedInstall: detectInstallMode(),
    dataDir,
    isDefaultDir,
    defaultDirDisplay,
  });
}
