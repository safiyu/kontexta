"use client";
import { useEffect, useRef } from "react";

export function useWebSocket(onEvent: (event: { type: string; path: string }) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    // Async IIFE to allow awaiting fetchWsConfig() before connect()
    (async () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsToken = process.env.NEXT_PUBLIC_WS_TOKEN || "";
      // Use the same hostname the browser used to reach this page.
      // The WS server is bound to 0.0.0.0 in Docker / LAN deployments,
      // so the client must connect to the same network interface.
      let hostname = window.location.hostname;
      if (hostname === "0.0.0.0") {
        hostname = "127.0.0.1";
      }
      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let cancelled = false;
      let attempt = 0;
      let stopReconnecting = false;
      let wsPort = "3001"; // fallback, overwritten by runtime fetch below

      const detach = (socket: WebSocket | null) => {
        if (!socket) return;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        (socket as any).onopen = null;
      };

      // Fetch runtime WS config once (port may differ from build-time defaults).
      // The client always connects to the same host it used to access the web app
      // (window.location.hostname), just with a potentially different port.
      const fetchWsConfig = async () => {
        try {
          const res = await fetch("/api/ws-config");
          if (res.ok) {
            const cfg = await res.json();
            wsPort = cfg.wsPort || wsPort;
          }
        } catch {
          // Use default port — non-fatal.
        }
      };

      // Await config before first connect so the correct port is used.
      await fetchWsConfig();

      const connect = async () => {
        if (cancelled || stopReconnecting) return;

        // 1. Fetch short-lived session token from Next.js (which has same-origin cookie access)
        let sessionToken = "";
        try {
          const res = await fetch("/api/auth/token");
          if (res.ok) {
            const data = await res.json();
            sessionToken = data.token;
          }
        } catch (err) {
          console.warn("[Kontexta] WS could not fetch session token:", err);
        }

        if (cancelled || stopReconnecting) return;

        // Prefer short-lived session token; fallback to legacy static token if present
        const token = sessionToken || wsToken;
        const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : "";
        const wsUrl = `${protocol}//${hostname}:${wsPort}${tokenSuffix}`;

        // Tear down any previous socket so a stale close can't double-reconnect.
        if (ws) {
          detach(ws);
          try { ws.close(); } catch {}
          ws = null;
        }
        ws = new WebSocket(wsUrl);
        ws.onopen = () => { attempt = 0; }; // reset backoff on successful handshake
        ws.onmessage = (msg) => {
          try {
            const event = JSON.parse(msg.data);
            onEventRef.current(event);
          } catch {}
        };
        ws.onclose = (ev) => {
          if (cancelled) return;
          // Auth failure (server returns 1008 / 4401). Hammering achieves
          // nothing — token won't change without reload.
          if (ev.code === 1008 || ev.code === 4401) {
            console.warn("[Kontexta] WS auth failed; stopping reconnect attempts");
            stopReconnecting = true;
            return;
          }
          // Exponential backoff capped at 30s with ±25% jitter.
          attempt++;
          const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
          const delay = base * (0.75 + Math.random() * 0.5);
          reconnectTimer = setTimeout(connect, delay);
        };
        // onerror is always followed by onclose; closing here would leak a socket.
        ws.onerror = () => {};
      };

      // Fetch runtime WS config before connecting (port/host may differ from build-time defaults).
      // Must await config before connect() so the correct wsHost/wsPort are used.
      await fetchWsConfig();
      connect();
      return () => {
        cancelled = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        detach(ws);
        try { ws?.close(); } catch {}
        ws = null;
      };
    })();
  }, []);
}
