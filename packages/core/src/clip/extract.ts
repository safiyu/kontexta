import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

// Node 18+'s global fetch is backed by undici; the `dispatcher` option is
// honored at runtime but missing from the public RequestInit types. We pass
// it via this widened init type so tests that mock global fetch (vi.spyOn
// against globalThis.fetch) still intercept this code path.
type FetchInitWithDispatcher = RequestInit & { dispatcher?: Agent };

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

interface ResolvedHost {
  /** Pre-validated address fetch must use. null for literal IPs (no DNS). */
  address: string | null;
  family: 4 | 6 | 0;
}

function normalizeHost(rawHost: string): string {
  // strip IPv6 brackets, lowercase, strip trailing dot (FQDN form that
  // bypasses naive endsWith checks: "localhost." resolves to loopback but
  // doesn't === "localhost").
  let h = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

async function assertPublicHost(parsed: URL): Promise<ResolvedHost> {
  const host = normalizeHost(parsed.hostname);
  if (!host) {
    throw new ClipError("INVALID_URL", `Empty hostname`);
  }
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
  if (kind !== 0) {
    // Literal IP — no DNS step; pinning not needed (URL host is the IP).
    return { address: null, family: kind as 4 | 6 };
  }
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
  if (resolved.length === 0) {
    throw new ClipError("FETCH_FAILED", `Host ${host} resolved to no addresses`);
  }
  for (const r of resolved) {
    if (r.family === 4 && isPrivateIPv4(r.address)) {
      throw new ClipError("INVALID_URL", `Host ${host} resolves to private IPv4 ${r.address}`);
    }
    if (r.family === 6 && isPrivateIPv6(r.address)) {
      throw new ClipError("INVALID_URL", `Host ${host} resolves to private IPv6 ${r.address}`);
    }
  }
  // Pin the first resolved address — fetch will connect to THIS IP, defeating
  // a DNS rebinding attack where the resolver returns a different IP on the
  // second lookup that fetch would otherwise perform internally.
  return { address: resolved[0].address, family: resolved[0].family as 4 | 6 };
}

/**
 * Build an undici Dispatcher that forces connections to the pre-validated IP
 * for `pinnedHost`, while preserving the hostname for TLS SNI / cert
 * verification. For any OTHER host (shouldn't happen since we control the
 * URL), undefined is returned to fall through to the system resolver.
 */
function pinnedDispatcher(pinnedHost: string, pinned: ResolvedHost) {
  if (pinned.address == null) return undefined;
  const pinnedNorm = pinnedHost;
  const addr = pinned.address;
  const fam = pinned.family;
  return new Agent({
    connect: {
      lookup(hostname, _opts, cb) {
        if (hostname === pinnedNorm) {
          cb(null, addr, fam);
        } else {
          // Refuse to resolve anything else through this dispatcher; the
          // caller built this for a single host only.
          cb(new Error(`Pinned dispatcher refused unknown host: ${hostname}`), "", 0);
        }
      },
    },
  });
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

// Headers that grant authority/identity and MUST be stripped when a redirect
// crosses origins. Browsers do this for Authorization automatically; Node
// fetch does not, so unconditionally reusing caller-supplied Cookie/Auth
// across hops would leak credentials to redirect targets (including attacker
// servers reachable by a 302 from a public domain).
const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
]);

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

function stripSensitiveHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (!SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const initialHeaders: Record<string, string> = {
    "User-Agent": "kontexta-clipper/1.0 (+https://kontexta.dev)",
    ...(opts.headers ?? {}),
  };
  let headers = initialHeaders;

  // Manual redirect handling so we can re-validate the host on every hop —
  // a public URL that 302s to http://169.254.169.254/ must NOT be followed —
  // and so we can strip credentials on cross-origin redirects.
  let currentUrl = url;
  let prevParsed: URL | null = null;
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
    const pinned = await assertPublicHost(parsed);

    // Strip sensitive headers if THIS hop is a cross-origin redirect from
    // the previous hop. The first hop always keeps caller headers (that's
    // the whole point of opts.headers).
    if (prevParsed && !sameOrigin(prevParsed, parsed)) {
      headers = stripSensitiveHeaders(headers);
    }

    const dispatcher = pinnedDispatcher(normalizeHost(parsed.hostname), pinned);
    const init: FetchInitWithDispatcher = {
      redirect: "manual",
      signal,
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    };
    try {
      res = await fetch(currentUrl, init as RequestInit);
    } catch (e) {
      throw new ClipError("FETCH_FAILED", `Network error fetching ${currentUrl}: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get("location");
      if (!loc) break;
      try { await res.body?.cancel(); } catch {}
      prevParsed = parsed;
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
