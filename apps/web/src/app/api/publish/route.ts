import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "kxta-publish/pipeline";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDataDir, getDatabase } from "kxta-core";

export interface PublishRequestBody {
  folders?: string[];
  title?: string;
  brand?: string;
  theme?: "default" | "minimal" | "api-ref";
  llmsTxt?: boolean;
  seo?: boolean;
  output?: string;
  /** Project ID to publish project folders from. Null or omitted = Knowledge Base. */
  projectId?: number | null;
}

export async function POST(request: NextRequest) {
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

    const outputDir = body.output || join(dataDir, "publish");

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
        hero: true,
      },
      output: indexPath,
      llmsTxt: body.llmsTxt ?? false,
      seo: body.seo ?? false,
      theme: body.theme || "default",
    };

    const result = runPipeline(config);

    // Write index.html
    writeFileSync(indexPath, result.html, "utf-8");

    // Write llms.txt if enabled
    if (body.llmsTxt) {
      const { generateLlmsTxt } = await import("kxta-publish/render/llms");
      const llmsPath = join(outputDir, "llms.txt");
      writeFileSync(
        llmsPath,
        generateLlmsTxt(result.docs, result.search, config.site.title),
        "utf-8"
      );
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
    const message = error instanceof Error ? error.message : "Publish failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  // Return publish status / last build info
  try {
    const dataDir = getDataDir();
    const outputDir = join(dataDir, "publish");

    if (!existsSync(outputDir)) {
      return NextResponse.json({ exists: false });
    }

    const indexPath = join(outputDir, "index.html");
    const llmsPath = join(outputDir, "llms.txt");

    return NextResponse.json({
      exists: true,
      outputDir,
      indexHtml: existsSync(indexPath),
      llmsTxt: existsSync(llmsPath),
    });
  } catch {
    return NextResponse.json({ exists: false });
  }
}
