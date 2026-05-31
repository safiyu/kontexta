import { NextResponse } from "next/server";

/**
 * Runtime WebSocket configuration endpoint.
 *
 * The client bundle reads this at runtime instead of relying on
 * build-time NEXT_PUBLIC_WS_PORT, so the port can be changed
 * without rebuilding the image.
 *
 * Returns the client-facing port (the port the browser should connect to),
 * which may differ from the internal container port when using Docker
 * port mapping (e.g., container 3001 → host 8008).
 */
export function GET() {
  // Prefer explicit client-facing port (for Docker port mapping scenarios)
  const wsPort = process.env.KONTEXTA_WS_CLIENT_PORT || process.env.WS_PORT || "3001";
  const wsHost = process.env.KONTEXTA_WS_HOST || "0.0.0.0";

  return NextResponse.json({
    wsPort,
    wsHost,
  });
}
