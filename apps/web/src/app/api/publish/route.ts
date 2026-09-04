import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "kxta-publish/pipeline";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { getDataDir, getDatabase, createFile } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { assertSafeOutputPath } from "@/lib/safe-path";

export interface PublishRequestBody {
  folders?: string[];
  title?: string;
  brand?: string;
  tagline?: string;
  hero?: boolean;
  theme?: "default" | "minimal" | "api-ref" | "flat" | "terminal" | "paper" | "solarized" | "brutalist" | "ocean";
  llmsTxt?: boolean;
  seo?: boolean;
  output?: string;
  /** Project ID to publish project folders from. Null or omitted = Knowledge Base. */
  projectId?: number | null;
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body: PublishRequestBody = await request.json();

    const dataDir = getDataDir();
    let projectPath: string | undefined = undefined;

    // Resolve projectId to projectPath if provided
    if (body.projectId !== null && body.projectId !== undefined) {
      const db = getDatabase();
      const project = db.prepare(
        "SELECT path FROM projects WHERE id = ?"
      ).get(body.projectId) as { path: string | null } | undefined;
      if (!project?.path) {
        return NextResponse.json(
          { success: false, error: `Project not found: ${body.projectId}` },
          { status: 404 }
        );
      }
      projectPath = project.path;
    }

    const defaultOutput = join(dataDir, "publish");
    let outputDir = defaultOutput;
    if (body.output) {
      try {
        outputDir = assertSafeOutputPath(body.output, dataDir);
      } catch (err) {
        return NextResponse.json(
          { success: false, error: (err as Error).message },
          { status: 400 }
        );
      }
    }

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const indexPath = join(outputDir, "index.html");
    const config = {
      source: {
        folders: body.folders || ["knowledge"],
        projectPath,
      },
      site: {
        title: body.title || "Kontexta Docs",
        brand: body.brand || "Kontexta",
        hero: body.hero ?? true,
        tagline: body.tagline || undefined,
      },
      output: indexPath,
      llmsTxt: body.llmsTxt ?? false,
      seo: body.seo ?? false,
      theme: body.theme || "default",
    };

    const result = runPipeline(config);

    // Write every pipeline output straight from result.outputs — avoids regenerating llms.txt with a second call.
    for (const out of result.outputs) {
      writeFileSync(join(outputDir, out.relPath), out.content, "utf-8");
    }

    // Index outputs in the KB (default location only — createFile's own upsert makes this idempotent); skipHtmlSanitize is safe since this is our own trusted pipeline output, not agent/user content.
    if (outputDir === defaultOutput) {
      for (const out of result.outputs) {
        const ext = out.relPath.split(".").pop()?.toLowerCase();
        let format: "html" | "md" | undefined;
        if (ext === "html") format = "html";
        else if (ext === "md") format = "md";
        if (!format) continue;
        const title = basename(out.relPath, `.${ext}`);
        try {
          await createFile({
            title,
            content: out.content,
            destination: "knowledge",
            folder: "publish",
            dataDir,
            format,
            skipHtmlSanitize: true,
          });
        } catch (err) {
          console.error(`Failed to index publish output ${out.relPath}:`, err);
        }
      }
    }

    return NextResponse.json({
      success: true,
      output: indexPath,
      docCount: result.report.docCount,
      endpointCount: result.report.endpointCount,
      termCount: result.report.termCount,
      llmsTxt: body.llmsTxt ? join(outputDir, "llms.txt") : null,
    });
  } catch (error) {
    // Log the full stack to the dev terminal so the cause is visible without
    // forcing the user to open browser DevTools and inspect the response
    // body. The trimmed message still goes back to the client.
    console.error("[api/publish] POST failed:", error);
    const message = error instanceof Error ? error.message : "Publish failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Return publish status / last build info
  try {
    const dataDir = getDataDir();
    const outputDir = join(dataDir, "publish");

    if (!existsSync(outputDir)) {
      return NextResponse.json({ exists: false });
    }

    const indexPath = join(outputDir, "index.html");
    const llmsPath = join(outputDir, "llms.txt");

    const indexExists = existsSync(indexPath);
    let lastBuilt: string | null = null;
    let sizeBytes: number | null = null;
    if (indexExists) {
      try {
        const st = statSync(indexPath);
        lastBuilt = st.mtime.toISOString();
        sizeBytes = st.size;
      } catch { /* ignore stat failures */ }
    }
    return NextResponse.json({
      exists: true,
      outputDir,
      indexHtml: indexExists,
      llmsTxt: existsSync(llmsPath),
      lastBuilt,
      sizeBytes,
    });
  } catch {
    return NextResponse.json({ exists: false });
  }
}
