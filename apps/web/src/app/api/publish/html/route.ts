import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "kxta-core";
import { checkAuth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dataDir = getDataDir();
    const outputDir = join(dataDir, "publish");
    const indexPath = join(outputDir, "index.html");

    if (!existsSync(indexPath)) {
      return NextResponse.json(
        { exists: false, error: "No published page found. Run a publish first." },
        { status: 404 }
      );
    }

    const html = readFileSync(indexPath, "utf-8");
    return new NextResponse(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return NextResponse.json(
      { exists: false, error: "Failed to read published page" },
      { status: 500 }
    );
  }
}
