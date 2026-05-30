import { checkAuth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { clipUrl, ClipError, type ClipErrorCode } from "kxta-core";
import { ensureDbInitialized, DATA_DIR } from "@/lib/db-init";

const STATUS_FOR_CODE: Record<ClipErrorCode, number> = {
  INVALID_URL: 400,
  FETCH_FAILED: 502,
  UNSUPPORTED_CONTENT_TYPE: 422,
  EXTRACTION_FAILED: 422,
  AUTH_REQUIRED: 401,
};

const ALLOWED_HEADERS = new Set(["cookie", "user-agent", "accept", "accept-language", "referer"]);

function filterAllowedHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (ALLOWED_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object") return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== "string") return false;
  }
  return true;
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();

  let body: { url?: unknown; title?: unknown; headers?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url : "";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
  const headers = isStringRecord(body.headers) ? filterAllowedHeaders(body.headers) : undefined;
  if (!url) {
    return NextResponse.json({ error: "Missing 'url' field" }, { status: 400 });
  }

  try {
    const file = await clipUrl({ url, title, dataDir: DATA_DIR, headers });
    return NextResponse.json(file);
  } catch (e) {
    if (e instanceof ClipError) {
      const payload: Record<string, unknown> = { error: e.message, code: e.code };
      if (e.code === "AUTH_REQUIRED") {
        payload.auth_required = true;
        if (e.details.loginUrl) payload.login_url = e.details.loginUrl;
        if (e.details.signal) payload.signal = e.details.signal;
        if (e.details.wwwAuthenticate) payload.www_authenticate = e.details.wwwAuthenticate;
      }
      return NextResponse.json(payload, { status: STATUS_FOR_CODE[e.code] ?? 500 });
    }
    return NextResponse.json({ error: (e as Error).message ?? "Internal error" }, { status: 500 });
  }
}
