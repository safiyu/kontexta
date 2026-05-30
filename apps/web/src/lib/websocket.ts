import { WebSocketServer, WebSocket } from "ws";
import { createFileWatcher, type WatcherEvent } from "kxta-core";
import type { SyncEvent } from "./sync-events";

// globalThis-cached so Next.js module duplication doesn't split the
// open-sockets Set across instances (broadcast would silently no-op).
declare global {
  // eslint-disable-next-line no-var
  var __kontextaWss: WebSocketServer | null | undefined;
  // eslint-disable-next-line no-var
  var __kontextaWsClients: Set<WebSocket> | undefined;
}

let wss: WebSocketServer | null = globalThis.__kontextaWss ?? null;
const clients: Set<WebSocket> = (globalThis.__kontextaWsClients ??= new Set());

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function startWebSocketServer(port: number, watchPaths: string[]) {
  if (wss) return wss;
  const host = process.env.KONTEXTA_WS_HOST || "127.0.0.1";
  const loopback = isLoopbackHost(host);

  // Non-loopback WS leaks absolute paths + project metadata. Require
  // origin allowlist and/or shared-secret token in that case.
  const allowedOrigins = (process.env.KONTEXTA_WS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const requiredToken = (process.env.KONTEXTA_WS_TOKEN || "").trim();

  if (!loopback && allowedOrigins.length === 0 && !requiredToken) {
    console.warn(
      `[Kontexta] WS bound to ${host} (non-loopback) WITHOUT auth. ` +
        "All connections will be rejected. Set KONTEXTA_WS_ORIGINS " +
        "(comma-separated allowed Origin headers) and/or KONTEXTA_WS_TOKEN " +
        "(shared secret query param) to enable network access."
    );
  }

  wss = new WebSocketServer({ port, host });
  globalThis.__kontextaWss = wss;

  wss.on("error", (e: any) => {
    if (e.code === "EADDRINUSE") {
      console.warn(`[Kontexta] WebSocket server port ${port} is already in use. Fast refresh detected.`);
    } else {
      console.error("[Kontexta] WebSocket server error:", e);
    }
    // Drop the failed instance so the next start call rebinds.
    try { wss?.close(); } catch {}
    wss = null;
    globalThis.__kontextaWss = null;
  });

  wss.on("connection", (ws, req) => {
    if (!loopback) {
      if (allowedOrigins.length === 0 && !requiredToken) {
        ws.close(1008, "WS auth not configured");
        return;
      }
      if (allowedOrigins.length > 0) {
        const origin = req.headers.origin;
        if (!origin || !allowedOrigins.includes(origin)) {
          ws.close(1008, "Origin not allowed");
          return;
        }
      }
      if (requiredToken) {
        let supplied: string | null = null;
        try {
          const u = new URL(req.url || "/", "http://_");
          supplied = u.searchParams.get("token");
        } catch {}
        if (supplied !== requiredToken) {
          ws.close(1008, "Invalid token");
          return;
        }
      }
    }
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  createFileWatcher(watchPaths, (event: WatcherEvent) => {
    broadcast(event);
  });

  return wss;
}

function broadcast(payload: unknown) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // send() can throw on a half-closed socket (race between the
    // readyState check and the actual write). Don't let one bad client
    // crash the watcher event loop.
    try {
      client.send(message);
    } catch (e) {
      console.warn("[Kontexta] WS send failed:", e);
      try { client.terminate(); } catch {}
      clients.delete(client);
    }
  }
}

export function broadcastSync(event: SyncEvent): void {
  broadcast(event);
}
