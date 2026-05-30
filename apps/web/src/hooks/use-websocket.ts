"use client";
import { useEffect, useRef } from "react";

export function useWebSocket(onEvent: (event: { type: string; path: string }) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WS_PORT || "3001";
    const wsToken = process.env.NEXT_PUBLIC_WS_TOKEN || "";
    const tokenSuffix = wsToken ? `?token=${encodeURIComponent(wsToken)}` : "";
    const wsUrl = `${protocol}//${window.location.hostname}:${wsPort}${tokenSuffix}`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let attempt = 0;
    let stopReconnecting = false;

    const detach = (socket: WebSocket | null) => {
      if (!socket) return;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      (socket as any).onopen = null;
    };

    const connect = () => {
      if (cancelled || stopReconnecting) return;
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

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      detach(ws);
      try { ws?.close(); } catch {}
      ws = null;
    };
  }, []);
}
