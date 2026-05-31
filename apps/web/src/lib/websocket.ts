import { WebSocketServer, WebSocket } from "ws";
import { createFileWatcher, type WatcherEvent } from "kxta-core";
import type { SyncEvent } from "./sync-events";
import { checkAuth, verifySession } from "@/lib/auth";

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
  const host = process.env.KONTEXTA_WS_HOST || (process.env.HOSTNAME === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1");
  const loopback = isLoopbackHost(host);

  // Non-loopback WS leaks absolute paths + project metadata. 
  // We now use the unified auth system (master password + bypass IPs).
  // The old KONTEXTA_WS_ORIGINS and KONTEXTA_WS_TOKEN are kept for legacy programmatic access,
  // but browsers will be authenticated via the kontexta_session cookie.
  const allowedOrigins = (process.env.KONTEXTA_WS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const requiredToken = (process.env.KONTEXTA_WS_TOKEN || "").trim();

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
    // Only null the reference if the server actually closed; otherwise keep
    // the old reference so the next start() call doesn't try to bind again
    // on the same port and loop on EADDRINUSE.
    if (wss) {
      wss = null;
      globalThis.__kontextaWss = null;
    }
  });

  wss.on("connection", (ws, req) => {
    // WS Auth Logic
    const reqForAuth = {
      headers: new Headers(req.headers as Record<string, string>),
    };
    
    // We add the remote address to headers for checkAuth to process IP bypasses
    const clientIp = req.socket.remoteAddress;
    if (clientIp) {
      reqForAuth.headers.set("x-real-ip", clientIp);
    }
    
    // 1. Check for cryptographically-signed short-lived token (used for browser client LAN connections)
    let oneTimeAuth = false;
    let tokenRejectReason = "";
    try {
      const u = new URL(req.url || "/", "http://_");
      const queryToken = u.searchParams.get("token");
      if (queryToken) {
        const payload = verifySession(queryToken);
        if (payload) {
          // Token is valid for 60 seconds from generation to prevent replay/leakage
          const age = Date.now() - payload.t;
          if (age >= 0 && age < 60_000) {
            oneTimeAuth = true;
          } else {
            tokenRejectReason = `Token expired (age: ${age}ms)`;
          }
        } else {
          tokenRejectReason = "Invalid token signature";
        }
      }
    } catch (e: any) {
      tokenRejectReason = `Token parse error: ${e.message}`;
    }

    // 2. If programmatic access matches legacy tokens/origins, allow it.
    let programmaticAuth = false;
    if (allowedOrigins.length > 0 && req.headers.origin && allowedOrigins.includes(req.headers.origin)) {
      programmaticAuth = true;
    }
    if (requiredToken) {
      try {
        const u = new URL(req.url || "/", "http://_");
        if (u.searchParams.get("token") === requiredToken) {
          programmaticAuth = true;
        }
      } catch {}
    }

    if (!oneTimeAuth && !programmaticAuth && !checkAuth(reqForAuth as any)) {
      console.warn(`[Kontexta] WS connection rejected from ${clientIp}. Reason: ${tokenRejectReason || "Unauthorized (no valid session cookie or IP bypass)"}`);
      ws.close(1008, "Unauthorized");
      return;
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
