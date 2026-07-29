import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "kxta-core";
import { renderMarkdownToPdf } from "kxta-publish/render/pdf";
import { ensureDbInitialized } from "@/lib/db-init";
import { basename } from "node:path";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  try {
    ensureDbInitialized();
    const { id } = await params;
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
    }
    let file;
    try {
      file = readFile(n);
    } catch (err) {
      console.error("[export-pdf] readFile failed:", err);
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await renderMarkdownToPdf(
        typeof file.content === "string" ? file.content : String(file.content ?? "")
      );
    } catch (err: any) {
      console.error("[export-pdf] renderMarkdownToPdf failed:", err);
      return NextResponse.json({ error: `PDF generation failed: ${err?.message ?? err}` }, { status: 500 });
    }

    const filename = basename(file.path).replace(/\.(md|mmd)$/i, "") + ".pdf";
    // Strip CR/LF/NUL (HTTP response splitting) and other control chars,
    // then quote-escape backslashes and double quotes for the quoted-string
    // form of Content-Disposition. Non-ASCII goes through `filename*` per
    // RFC 5987 so the legacy `filename=` token stays pure ASCII.
    const asciiSafe = filename
      .replace(/[\x00-\x1f\x7f"\\]/g, "_")
      .replace(/[^\x20-\x7e]/g, "_");
    const utf8Encoded = encodeURIComponent(filename).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdfBuffer.byteLength),
        "Content-Disposition": `attachment; filename="${asciiSafe}"; filename*=UTF-8''${utf8Encoded}`,
      },
    });
  } catch (err: any) {
    // Catch-all: surfaces anything outside the two narrower try/catch
    // blocks above (e.g. a failure in ensureDbInitialized or header
    // construction) with a full stack trace in the server log, instead of
    // an opaque framework 500 page.
    console.error("[export-pdf] unexpected failure:", err);
    return NextResponse.json({ error: `Export failed: ${err?.message ?? err}` }, { status: 500 });
  }
}
