import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Cached for the lifetime of the process; both files only change between deploys.
let cached: { version: string; changelog: string } | null = null;

function findFirstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadAboutInfo() {
  if (cached) return cached;
  const cwd = process.cwd();
  // cwd is the monorepo root for `next dev`/local, but `apps/web` for the
  // Next.js standalone server (server.js chdirs into __dirname).
  const packagePath = findFirstExisting([
    path.join(cwd, "package.json"),
    path.join(cwd, "..", "..", "package.json"),
  ]);
  const changelogPath = findFirstExisting([
    path.join(cwd, "CHANGELOG.md"),
    path.join(cwd, "..", "..", "CHANGELOG.md"),
  ]);

  let version = "unknown";
  let changelog = "";

  if (packagePath) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
      if (typeof pkg.version === "string") version = pkg.version;
    } catch (e) {
      console.warn("[/api/about] failed to read package.json:", e);
    }
  } else {
    console.warn("[/api/about] package.json not found");
  }

  if (changelogPath) {
    try {
      const changelogContent = readFileSync(changelogPath, "utf-8");
      const sections = changelogContent.split(/\n(?=## )/);
      changelog = sections.slice(0, 6).join("\n"); // header + 5 releases
    } catch (e) {
      console.warn("[/api/about] failed to read CHANGELOG.md:", e);
    }
  } else {
    console.warn("[/api/about] CHANGELOG.md not found");
  }

  cached = { version, changelog };
  return cached;
}

export async function GET() {
  const { version, changelog } = loadAboutInfo();
  return NextResponse.json({
    name: "Kontexta",
    author: "Safiyu",
    version,
    changelog,
  });
}
