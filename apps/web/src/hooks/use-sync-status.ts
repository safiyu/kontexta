"use client";

import { useEffect, useRef, useState } from "react";
import { isSyncEvent, type SyncEvent } from "@/lib/sync-events";
import type { SyncLogEntry } from "@/components/sync/sync-popover";

export type SyncStatus = "idle" | "syncing" | "ok" | "error" | "no-remote";

export interface UseSyncStatusResult {
  status: SyncStatus;
  lastDoneAt: number | null;
  stage: string | null;
  log: SyncLogEntry[];
}

export function useSyncStatus(globalRemoteUrl: string | null): UseSyncStatusResult {
  const [status, setStatus] = useState<SyncStatus>(globalRemoteUrl ? "idle" : "no-remote");
  const [lastDoneAt, setLastDoneAt] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [log, setLog] = useState<SyncLogEntry[]>([]);

  // Reconcile when globalRemoteUrl arrives async; preserve in-flight statuses.
  useEffect(() => {
    setStatus((prev) => {
      if (prev === "syncing" || prev === "ok" || prev === "error") return prev;
      return globalRemoteUrl ? "idle" : "no-remote";
    });
  }, [globalRemoteUrl]);

  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    // Async IIFE to allow awaiting fetchWsConfig() before connect()
    (async () => {
      if (typeof window === "undefined") return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsToken = process.env.NEXT_PUBLIC_WS_TOKEN || "";
      // Use the same hostname the browser used to reach this page.
      // The WS server is bound to 0.0.0.0 in Docker / LAN deployments,
      // so the client must connect to the same network interface.
      let hostname = window.location.hostname;
      if (hostname === "0.0.0.0") {
        hostname = "127.0.0.1";
      }
      let cancelled = false;
      let reconnect: ReturnType<typeof setTimeout> | null = null;
      let attempt = 0;
      let stopReconnecting = false;

      const detach = (socket: WebSocket | null) => {
        if (!socket) return;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
      };

      // Fetch runtime WS config once (port may differ from build-time defaults).
      // The client always connects to the same host it used to access the web app
      // (window.location.hostname), just with a potentially different port.
      let wsPort = "3001"; // fallback, overwritten by runtime fetch below
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

      const handleEvent = (e: SyncEvent) => {
        if (e.type === "sync:start") {
          setStatus("syncing");
          setStage("preparing");
        } else if (e.type === "sync:stage") {
          setStage(e.stage);
        } else if (e.type === "sync:done") {
          setStatus("ok");
          setStage(null);
          setLastDoneAt(e.at);
          setLog((prev) => [{ projectId: e.projectId, result: "ok" as const, at: e.at }, ...prev].slice(0, 50));
        } else if (e.type === "sync:error") {
          setStatus("error");
          setStage(null);
          setLog((prev) => [{ projectId: e.projectId, result: "error" as const, at: e.at, message: e.message }, ...prev].slice(0, 50));
        }
      };

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
          console.warn("[Kontexta] sync-status WS could not fetch session token:", err);
        }

        if (cancelled || stopReconnecting) return;

        // Prefer short-lived session token; fallback to legacy static token if present
        const token = sessionToken || wsToken;
        const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : "";
        const wsUrl = `${protocol}//${hostname}:${wsPort}${tokenSuffix}`;

        if (wsRef.current) {
          detach(wsRef.current);
          try { wsRef.current.close(); } catch {}
        }
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => { attempt = 0; };
        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (!isSyncEvent(data)) return;
            handleEvent(data);
          } catch {}
        };
        ws.onclose = (ev) => {
          if (cancelled) return;
          if (ev.code === 1008 || ev.code === 4401) {
            console.warn("[Kontexta] sync-status WS auth failed; stopping reconnect attempts");
            stopReconnecting = true;
            return;
          }
          attempt++;
          const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
          const delay = base * (0.75 + Math.random() * 0.5);
          reconnect = setTimeout(connect, delay);
        };
      };
      // Fetch runtime WS config before connecting (port/host may differ from build-time defaults).
      // Must await config before connect() so the correct wsHost/wsPort are used.
      await fetchWsConfig();
      connect();
      return () => {
        cancelled = true;
        if (reconnect) clearTimeout(reconnect);
        detach(wsRef.current);
        try { wsRef.current?.close(); } catch {}
        wsRef.current = null;
      };
    })();
  }, []);

  return { status, lastDoneAt, stage, log };
}
