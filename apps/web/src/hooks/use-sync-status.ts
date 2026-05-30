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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WS_PORT || "3001";
    const wsToken = process.env.NEXT_PUBLIC_WS_TOKEN || "";
    const tokenSuffix = wsToken ? `?token=${encodeURIComponent(wsToken)}` : "";
    const url = `${protocol}//${window.location.hostname}:${wsPort}${tokenSuffix}`;
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

    const connect = () => {
      if (cancelled || stopReconnecting) return;
      if (wsRef.current) {
        detach(wsRef.current);
        try { wsRef.current.close(); } catch {}
      }
      const ws = new WebSocket(url);
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
    connect();
    return () => {
      cancelled = true;
      if (reconnect) clearTimeout(reconnect);
      detach(wsRef.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
  }, []);

  return { status, lastDoneAt, stage, log };
}
