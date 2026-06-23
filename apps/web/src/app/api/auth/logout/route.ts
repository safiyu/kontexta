import { NextRequest, NextResponse } from "next/server";

/**
 * Normalize a host header value for comparison: lowercase, strip the
 * default-for-the-scheme port. So "Foo:443" with https → "foo", "foo:3000"
 * with anything → "foo:3000".
 */
function normHost(host: string, scheme: string | null): string {
  let h = host.trim().toLowerCase();
  if (scheme === "https" && h.endsWith(":443")) h = h.slice(0, -4);
  if (scheme === "http" && h.endsWith(":80")) h = h.slice(0, -3);
  return h;
}

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    // Same-origin fetch from a recent browser will always include Origin on
    // mutating methods; absence is unusual enough to reject so a top-level
    // <form action="...logout"> from another site doesn't slip through.
    return false;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const originScheme = originUrl.protocol.replace(/:$/, "");
  const originHost = normHost(originUrl.host, originScheme);

  // Build the candidate host list. `Host` is what Next.js bound to, but on
  // reverse-proxied deploys (Cloud Workstations, nginx, Cloudflare Tunnel,
  // Docker w/ host-network rewriting) it's the INTERNAL hostname while the
  // browser's Origin is the PUBLIC one — so also accept `x-forwarded-host`.
  // The forwarded list is a chain; the first entry is the originally-reached
  // host that we care about.
  const candidates: string[] = [];
  const host = req.headers.get("host");
  if (host) candidates.push(normHost(host, originScheme));
  const xfh = req.headers.get("x-forwarded-host");
  if (xfh) {
    for (const h of xfh.split(",")) {
      const trimmed = h.trim();
      if (trimmed) candidates.push(normHost(trimmed, originScheme));
    }
  }

  return candidates.includes(originHost);
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const response = NextResponse.json({ success: true });
  response.cookies.delete("kontexta_session");
  // Set a "locked" cookie so the IP bypass is suppressed until the user
  // explicitly re-authenticates via the login form.
  response.cookies.set("kontexta_locked", "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // No maxAge — this is a session cookie, cleared on browser close or login.
  });
  return response;
}
