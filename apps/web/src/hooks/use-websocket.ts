"use client";
import { useEffect, useRef } from "react";

export function useWebSocket(onEvent: (event: { type: string; path: string }) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    // Connection state lives in this useEffect's scope (NOT inside the async
    // IIFE) so the cleanup returned to React can flip `cancelled` and close
    // the socket synchronously on unmount. Returning the cleanup from inside
    // an async function would lose it — useEffect ignores the returned Promise.
    const state: {
      ws: WebSocket | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      cancelled: boolean;
      stopReconnecting: boolean;
      attempt: number;
    } = { ws: null, reconnectTimer: null, cancelled: false, stopReconnecting: false, attempt: 0 };

    const detach = (socket: WebSocket | null) => {
      if (!socket) return;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      (socket as any).onopen = null;
    };

    const connect = async () => {
      if (state.cancelled || state.stopReconnecting) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsToken = process.env.NEXT_PUBLIC_WS_TOKEN || "";

      // Fetch short-lived session token from Next.js (same-origin cookie access).
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

      if (state.cancelled || state.stopReconnecting) return;

      // Prefer short-lived session token; fallback to legacy static token if present.
      const token = sessionToken || wsToken;
      const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : "";
      // Share Next.js's HTTP server on the same origin (single port). The WS
      // server only handles upgrades to /_kontexta_ws.
      const wsUrl = `${protocol}//${window.location.host}/_kontexta_ws${tokenSuffix}`;

      // Tear down any previous socket so a stale close can't double-reconnect.
      if (state.ws) {
        detach(state.ws);
        try { state.ws.close(); } catch {}
        state.ws = null;
      }
      const ws = new WebSocket(wsUrl);
      state.ws = ws;
      ws.onopen = () => { state.attempt = 0; };
      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data);
          onEventRef.current(event);
        } catch {}
      };
      ws.onclose = (ev) => {
        if (state.cancelled) return;
        // Auth failure (server returns 1008 / 4401). Hammering achieves
        // nothing — token won't change without reload.
        if (ev.code === 1008 || ev.code === 4401) {
          console.warn("[Kontexta] WS auth failed; stopping reconnect attempts");
          state.stopReconnecting = true;
          return;
        }
        // Exponential backoff capped at 30s with ±25% jitter.
        state.attempt++;
        const base = Math.min(30_000, 1000 * 2 ** Math.min(state.attempt, 5));
        const delay = base * (0.75 + Math.random() * 0.5);
        state.reconnectTimer = setTimeout(connect, delay);
      };
      // onerror is always followed by onclose; closing here would leak a socket.
      ws.onerror = () => {};
    };

    connect();

    return () => {
      state.cancelled = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      detach(state.ws);
      try { state.ws?.close(); } catch {}
      state.ws = null;
    };
  }, []);
}
