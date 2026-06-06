import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { Server } from "node:http";
import type { Duplex } from "node:stream";
import { createFileWatcher, type WatcherEvent } from "kxta-core";
import type { SyncEvent } from "./sync-events";
import { checkAuth, verifySession } from "@/lib/auth";

// The dedicated upgrade path. WS shares Next.js's HTTP server (single port);
// only upgrades to this path are handled here, so Next's HMR upgrades are
// left untouched for Next's own listener.
export const WS_PATH = "/_kontexta_ws";

// globalThis-cached so Next.js module duplication doesn't split the
// open-sockets Set across instances (broadcast would silently no-op).
declare global {
  // eslint-disable-next-line no-var
  var __kontextaWss: WebSocketServer | null | undefined;
  // eslint-disable-next-line no-var
  var __kontextaWsClients: Set<WebSocket> | undefined;
  // eslint-disable-next-line no-var
  var __kontextaListenPatched: boolean | undefined;
}

let wss: WebSocketServer | null = globalThis.__kontextaWss ?? null;
const clients: Set<WebSocket> = (globalThis.__kontextaWsClients ??= new Set());

// Per-server marker so we never attach our upgrade listener twice to the
// same HTTP server (the listen() patch can fire more than once in dev).
const ATTACHED = Symbol.for("kontexta.wsUpgradeAttached");

export function attachWebSocketServer(watchPaths: string[]) {
  if (wss) return wss;

  // Non-loopback WS leaks absolute paths + project metadata.
  // We use the unified auth system (master password + bypass IPs).
  // The old KONTEXTA_WS_ORIGINS and KONTEXTA_WS_TOKEN are kept for legacy
  // programmatic access, but browsers are authenticated via the
  // kontexta_session cookie.
  const allowedOrigins = (process.env.KONTEXTA_WS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const requiredToken = (process.env.KONTEXTA_WS_TOKEN || "").trim();

  // No own socket — we ride on Next.js's HTTP server via the upgrade event.
  wss = new WebSocketServer({ noServer: true });
  globalThis.__kontextaWss = wss;

  wss.on("error", (e: any) => {
    console.error("[Kontexta] WebSocket server error:", e);
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    try {
      pathname = new URL(req.url || "/", "http://_").pathname;
    } catch {
      return;
    }
    // Not ours (e.g. Next.js HMR) — leave the socket alone so Next's own
    // upgrade listener can handle it. Never destroy it here.
    if (pathname !== WS_PATH) return;
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  };

  // Patch the stable Node API http.Server.prototype.listen (NOT Next
  // internals) so that whatever HTTP server Next.js creates gets our
  // upgrade listener attached the moment it binds. register() runs before
  // Next calls listen(), and this patch is installed synchronously, so the
  // listener is in place when the server starts.
  if (!globalThis.__kontextaListenPatched) {
    globalThis.__kontextaListenPatched = true;
    const proto = Server.prototype as any;
    const originalListen = proto.listen;
    proto.listen = function (this: HttpServer, ...args: any[]) {
      if (!(this as any)[ATTACHED]) {
        (this as any)[ATTACHED] = true;
        this.on("upgrade", handleUpgrade);
      }
      return originalListen.apply(this, args);
    };
  }

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
