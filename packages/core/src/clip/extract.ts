import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ClipErrorCode =
  | "INVALID_URL"
  | "FETCH_FAILED"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "EXTRACTION_FAILED"
  | "AUTH_REQUIRED";

export interface ClipErrorDetails {
  loginUrl?: string;
  wwwAuthenticate?: string;
  signal?: AuthSignal;
}

export type AuthSignal =
  | "http_401"
  | "http_403"
  | "redirect_to_login"
  | "login_page_body";

export class ClipError extends Error {
  public readonly details: ClipErrorDetails;
  constructor(
    public code: ClipErrorCode,
    message: string,
    details: ClipErrorDetails = {}
  ) {
    super(message);
    this.name = "ClipError";
    this.details = details;
  }
}

const MIN_BODY_CHARS = 200;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_REDIRECTS = 5;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||                                  // "this" network
    a === 10 ||                                 // RFC1918
    a === 127 ||                                // loopback
    (a === 169 && b === 254) ||                 // link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||        // RFC1918
    (a === 192 && b === 168) ||                 // RFC1918
    (a === 100 && b >= 64 && b <= 127) ||       // CGNAT
    a >= 224                                    // multicast / reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split("%")[0]; // strip zone id
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  const m = lower.match(/^::ffff:([0-9.]+)$/);
  if (m) return isPrivateIPv4(m[1]);
  return false;
}

async function assertPublicHost(parsed: URL): Promise<void> {
  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // Block obvious local/special TLDs and bare names
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  ) {
    throw new ClipError("INVALID_URL", `Refusing to clip non-public host: ${host}`);
  }
  const kind = isIP(host);
  if (kind === 4 && isPrivateIPv4(host)) {
    throw new ClipError("INVALID_URL", `Refusing to clip private/loopback IPv4: ${host}`);
  }
  if (kind === 6 && isPrivateIPv6(host)) {
    throw new ClipError("INVALID_URL", `Refusing to clip private/loopback IPv6: ${host}`);
  }
  if (kind !== 0) return;
  // Block obfuscated IPv4 (decimal/hex/octal) before DNS — resolver may map to loopback.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^0\d+(\.[0-9a-fx]+){0,3}$/i.test(host)) {
    throw new ClipError("INVALID_URL", `Refusing to clip obfuscated numeric host: ${host}`);
  }
  let resolved;
  try {
    resolved = await lookup(host, { all: true });
  } catch (e) {
    throw new ClipError("FETCH_FAILED", `DNS lookup failed for ${host}: ${(e as Error).message}`);
  }
  for (const r of resolved) {
    if (r.family === 4 && isPrivateIPv4(r.address)) {
      throw new ClipError("INVALID_URL", `Host ${host} resolves to private IPv4 ${r.address}`);
    }
    if (r.family === 6 && isPrivateIPv6(r.address)) {
      throw new ClipError("INVALID_URL", `Host ${host} resolves to private IPv6 ${r.address}`);
    }
  }
}

async function readBodyWithCap(res: Response): Promise<string> {
  const cl = res.headers.get("content-length");
  if (cl && Number.isFinite(Number(cl)) && Number(cl) > MAX_RESPONSE_BYTES) {
    throw new ClipError("FETCH_FAILED", `Response too large: ${cl} bytes (max ${MAX_RESPONSE_BYTES})`);
  }
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new ClipError("FETCH_FAILED", `Response exceeded ${MAX_RESPONSE_BYTES} byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks as any).toString("utf-8");
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

export interface ExtractResult {
  title: string;
  markdown: string;
}

const LOGIN_URL_PATTERNS = [
  /\/login(\b|\/|\?|$)/i,
  /\/signin(\b|\/|\?|$)/i,
  /\/sign-in(\b|\/|\?|$)/i,
  /\/sso\//i,
  /\/oauth\//i,
  /\/auth\//i,
  /\/saml\//i,
  /\/account\/login/i,
  /[?&](redirect_to|return_to|next|destination|os_destination)=/i,
];

function looksLikeLoginUrl(url: string): boolean {
  return LOGIN_URL_PATTERNS.some((re) => re.test(url));
}

function looksLikeLoginPage(html: string): boolean {
  // Cheap pre-check before parsing — most real articles don't have these tokens at all.
  const cheap = /<input[^>]+type=["']?password["']?/i.test(html)
    || /name=["']os_username["']/i.test(html)              // Atlassian / Confluence
    || /name=["']j_username["']/i.test(html)               // Spring Security
    || /<form[^>]+action=["'][^"']*\/(login|signin|j_security_check)/i.test(html)
    || /window\.location[^;]+\/login/i.test(html);
  return cheap;
}

export async function extractFromHtml(html: string, url: string): Promise<ExtractResult> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const bodyLen = (article?.textContent ?? "").trim().length;
  if (!article || !article.content || bodyLen < MIN_BODY_CHARS) {
    if (looksLikeLoginPage(html)) {
      throw new ClipError(
        "AUTH_REQUIRED",
        `Page at ${url} appears to require authentication (login form detected)`,
        { loginUrl: url, signal: "login_page_body" }
      );
    }
    throw new ClipError(
      "EXTRACTION_FAILED",
      `Could not extract enough article content from ${url}`
    );
  }

  const markdown = turndown.turndown(article.content);
  const title = (article.title || dom.window.document.title || "").trim() || "Untitled";

  return { title, markdown };
}

export interface FetchOptions {
  headers?: Record<string, string>;
}

export interface FetchResult {
  html: string;
  finalUrl: string;
}

export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "User-Agent": "kontexta-clipper/1.0 (+https://kontexta.dev)",
    ...(opts.headers ?? {}),
  };

  // Manual redirect handling so we can re-validate the host on every hop —
  // a public URL that 302s to http://169.254.169.254/ must NOT be followed.
  let currentUrl = url;
  let res: Response | null = null;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new ClipError("INVALID_URL", `Not a valid URL: ${currentUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ClipError("INVALID_URL", `Unsupported protocol: ${parsed.protocol}`);
    }
    await assertPublicHost(parsed);

    try {
      res = await fetch(currentUrl, { redirect: "manual", signal, headers });
    } catch (e) {
      throw new ClipError("FETCH_FAILED", `Network error fetching ${currentUrl}: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get("location");
      if (!loc) break;
      try { await res.body?.cancel(); } catch {}
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    break;
  }
  if (!res) {
    throw new ClipError("FETCH_FAILED", `No response for ${url}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ClipError("FETCH_FAILED", `Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
  }

  const finalUrl = res.url || currentUrl;

  if (res.status === 401) {
    throw new ClipError(
      "AUTH_REQUIRED",
      `HTTP 401 Unauthorized fetching ${url}`,
      {
        loginUrl: finalUrl,
        wwwAuthenticate: res.headers.get("www-authenticate") ?? undefined,
        signal: "http_401",
      }
    );
  }
  if (res.status === 403) {
    throw new ClipError(
      "AUTH_REQUIRED",
      `HTTP 403 Forbidden fetching ${url} (likely auth required)`,
      { loginUrl: finalUrl, signal: "http_403" }
    );
  }

  if (!res.ok) {
    throw new ClipError("FETCH_FAILED", `HTTP ${res.status} fetching ${url}`);
  }

  // Redirect-to-login: original wasn't login-shaped, but we landed on a login page.
  if (finalUrl !== url && looksLikeLoginUrl(finalUrl) && !looksLikeLoginUrl(url)) {
    throw new ClipError(
      "AUTH_REQUIRED",
      `Request for ${url} was redirected to login page ${finalUrl}`,
      { loginUrl: finalUrl, signal: "redirect_to_login" }
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml+xml")) {
    throw new ClipError("UNSUPPORTED_CONTENT_TYPE", `Expected text/html, got ${contentType || "(none)"} from ${url}`);
  }

  const html = await readBodyWithCap(res);
  return { html, finalUrl };
}
