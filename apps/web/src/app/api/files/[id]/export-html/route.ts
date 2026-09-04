import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { readFile, getDataDir } from "kxta-core";
import { renderHtmlToPdf, renderHtmlToPng } from "kxta-publish/render/html-export";
import { ensureDbInitialized } from "@/lib/db-init";
import { basename, join } from "node:path";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  try {
    ensureDbInitialized();
    const { id } = await params;
    const format = req.nextUrl.searchParams.get("format") === "png" ? "png" : "pdf";
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
    }
    let file;
    try {
      file = readFile(n);
    } catch (err) {
      console.error("[export-html] readFile failed:", err);
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (!file.path.endsWith(".html")) {
      return NextResponse.json({ error: "Not an HTML file" }, { status: 400 });
    }

    const assetsDir = join(getDataDir(), "reports", "resources");
    let buffer: Buffer;
    try {
      const content = typeof file.content === "string" ? file.content : String(file.content ?? "");
      buffer = format === "pdf"
        ? await renderHtmlToPdf(content, { assetsDir })
        : await renderHtmlToPng(content, { assetsDir });
    } catch (err: any) {
      console.error(`[export-html] render to ${format} failed:`, err);
      return NextResponse.json({ error: `${format.toUpperCase()} generation failed: ${err?.message ?? err}` }, { status: 500 });
    }

    const filename = basename(file.path).replace(/\.html$/i, "") + (format === "pdf" ? ".pdf" : ".png");
    const asciiSafe = filename
      .replace(/[\x00-\x1f\x7f"\\]/g, "_")
      .replace(/[^\x20-\x7e]/g, "_");
    const utf8Encoded = encodeURIComponent(filename).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": format === "pdf" ? "application/pdf" : "image/png",
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `attachment; filename="${asciiSafe}"; filename*=UTF-8''${utf8Encoded}`,
      },
    });
  } catch (err: any) {
    console.error("[export-html] unexpected failure:", err);
    return NextResponse.json({ error: `Export failed: ${err?.message ?? err}` }, { status: 500 });
  }
}
