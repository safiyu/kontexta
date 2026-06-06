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
    if (typeof window === "undefined") return;

    // State lives in this useEffect's scope (NOT inside an async IIFE) so
    // the cleanup returned to React can flip `cancelled` and close the
    // socket synchronously on unmount. Returning the cleanup from inside
    // an async function would lose it — useEffect ignores the returned Promise.
    const state: {
      reconnect: ReturnType<typeof setTimeout> | null;
      cancelled: boolean;
      stopReconnecting: boolean;
      attempt: number;
    } = { reconnect: null, cancelled: false, stopReconnecting: false, attempt: 0 };

    const detach = (socket: WebSocket | null) => {
      if (!socket) return;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
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
      if (state.cancelled || state.stopReconnecting) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsToken = process.env.NEXT_PUBLIC_WS_TOKEN || "";

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

      if (state.cancelled || state.stopReconnecting) return;

      const token = sessionToken || wsToken;
      const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : "";
      // Share Next.js's HTTP server on the same origin (single port). The WS
      // server only handles upgrades to /_kontexta_ws.
      const wsUrl = `${protocol}//${window.location.host}/_kontexta_ws${tokenSuffix}`;

      if (wsRef.current) {
        detach(wsRef.current);
        try { wsRef.current.close(); } catch {}
      }
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => { state.attempt = 0; };
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (!isSyncEvent(data)) return;
          handleEvent(data);
        } catch {}
      };
      ws.onclose = (ev) => {
        if (state.cancelled) return;
        if (ev.code === 1008 || ev.code === 4401) {
          console.warn("[Kontexta] sync-status WS auth failed; stopping reconnect attempts");
          state.stopReconnecting = true;
          return;
        }
        state.attempt++;
        const base = Math.min(30_000, 1000 * 2 ** Math.min(state.attempt, 5));
        const delay = base * (0.75 + Math.random() * 0.5);
        state.reconnect = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      state.cancelled = true;
      if (state.reconnect) clearTimeout(state.reconnect);
      detach(wsRef.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
  }, []);

  return { status, lastDoneAt, stage, log };
}
