import { NextRequest, NextResponse } from "next/server";
import { readFile } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";
import { basename } from "node:path";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  ensureDbInitialized();
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return NextResponse.json({ error: `Invalid id: ${id}` }, { status: 400 });
  }
  let file;
  try {
    file = readFile(n);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  const filename = basename(file.path);
  // Strip CR/LF/NUL (HTTP response splitting) and other control chars,
  // then quote-escape backslashes and double quotes for the quoted-string
  // form of Content-Disposition. Non-ASCII goes through `filename*` per
  // RFC 5987 so the legacy `filename=` token stays pure ASCII.
  const asciiSafe = filename
    .replace(/[\x00-\x1f\x7f"\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_");
  const utf8Encoded = encodeURIComponent(filename).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const body = Buffer.from(typeof file.content === "string" ? file.content : String(file.content ?? ""), "utf-8");
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `attachment; filename="${asciiSafe}"; filename*=UTF-8''${utf8Encoded}`,
    },
  });
}
