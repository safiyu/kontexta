import crypto from "node:crypto";
import { getSetting, setSetting } from "kxta-core";

const SALT_LEN = 32;
const KEY_LEN = 64;

declare global {
  // eslint-disable-next-line no-var
  var __kontextaTmpSessionSecret: string | undefined;
  // eslint-disable-next-line no-var
  var __kontextaSessionSecret: string | undefined;
}

// Use a consistent secret for signing sessions.
// We store it in the DB to survive restarts and cache it in memory.
export function getSessionSecret(): string {
  if (globalThis.__kontextaSessionSecret) {
    return globalThis.__kontextaSessionSecret;
  }
  let secret: string | null = null;
  try {
    secret = getSetting("auth_session_secret");
  } catch {
    // DB may not be initialized yet; generate a temporary in-memory secret.
    // This is safe: session tokens will just be invalidated on next restart.
    return globalThis.__kontextaTmpSessionSecret ?? 
      (globalThis.__kontextaTmpSessionSecret = crypto.randomBytes(32).toString("hex"));
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    setSetting("auth_session_secret", secret);
  }
  globalThis.__kontextaSessionSecret = secret;
  return secret;
}

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(SALT_LEN).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const derivedHash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derivedHash, "hex"));
}

export function signSession(payload: { ip?: string; t: number }): string {
  const secret = getSessionSecret();
  const data = Buffer.from(JSON.stringify(payload)).toString("base64");
  const hmac = crypto.createHmac("sha256", secret).update(data).digest("hex");
  return `${data}.${hmac}`;
}

export function verifySession(token: string): { ip?: string; t: number } | null {
  try {
    const [data, hmac] = token.split(".");
    if (!data || !hmac) return null;
    const secret = getSessionSecret();
    const expectedHmac = crypto.createHmac("sha256", secret).update(data).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expectedHmac, "hex"))) {
      return null;
    }
    return JSON.parse(Buffer.from(data, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * Helper to check if a specific IP or request host should bypass authentication.
 * Returns false if the settings table doesn't exist yet (safe default).
 */
export function isBypassed(ip: string | undefined): boolean {
  let bypassList: string | null = null;
  try {
    bypassList = getSetting("auth_bypass_ips");
  } catch {
    return false; // Settings table not ready, deny bypass
  }
  if (!bypassList) return false;
  
  const allowed = bypassList.split(",").map(s => s.trim());
  if (ip && allowed.includes(ip)) {
    return true;
  }
  
  // Check for loopback/localhost if wildcard or explicit
  if (allowed.includes("127.0.0.1") || allowed.includes("localhost") || allowed.includes("*")) {
    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  }
  
  return false;
}

/**
 * Checks if the current request is authenticated.
 * Call this at the top of protected API routes.
 * Returns true (open) if the settings table isn't ready yet — the error
 * will surface as a 500 from the actual DB call, not a silent auth bypass.
 */
export function checkAuth(req: Request | { cookies: { get: (name: string) => { value: string } | undefined }, headers: Headers }): boolean {
  // If no password is set (or table not ready), we don't enforce auth.
  let hash: string | null = null;
  try {
    hash = getSetting("auth_password_hash");
  } catch {
    // Settings table doesn't exist yet (race during first boot/HMR).
    // Return true to avoid blocking the app — the page itself will still 
    // fail gracefully if anything else tries to touch the DB.
    return true;
  }
  if (!hash) return true;

  // Resolve client IP from headers.
  // X-Forwarded-For / X-Real-IP are client-controlled unless a trusted proxy
  // sets them. Without a proxy in front, any caller can spoof these headers
  // and match an allowlisted bypass IP. Default to ignoring them; users behind
  // a reverse proxy (nginx, Caddy, Cloudflare Tunnel) must explicitly opt in
  // via the auth_trust_proxy_headers setting.
  let trustProxy = false;
  try {
    trustProxy = getSetting("auth_trust_proxy_headers") === "true";
  } catch {
    trustProxy = false;
  }
  const ip = trustProxy
    ? (req.headers.get("x-forwarded-for")?.split(",")[0].trim()
        ?? req.headers.get("x-real-ip")
        ?? undefined)
    : undefined;

  // If the user explicitly locked the app, skip IP bypass until they
  // re-authenticate via the login form (kontexta_locked cookie is set by logout).
  let isExplicitlyLocked = false;
  if ("cookies" in req && typeof req.cookies.get === "function") {
    isExplicitlyLocked = !!req.cookies.get("kontexta_locked")?.value;
  } else {
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) {
      isExplicitlyLocked = /(?:^|;\s*)kontexta_locked=1/.test(cookieHeader);
    }
  }

  if (!isExplicitlyLocked && isBypassed(ip)) return true;

  // Check session cookie
  let token: string | null | undefined = null;
  if ("cookies" in req && typeof req.cookies.get === "function") {
    token = req.cookies.get("kontexta_session")?.value;
  } else {
    // Parse from Cookie header, URL-decoding the value
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)kontexta_session=([^;]+)/);
      if (match) {
        try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }
      }
    }
  }

  if (token && verifySession(token)) {
    return true;
  }

  return false;
}
