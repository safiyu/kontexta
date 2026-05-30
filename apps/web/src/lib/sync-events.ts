/**
 * Typed sync event payloads broadcast over the existing WebSocket channel.
 * Producers: API routes that perform git sync.
 * Consumers: status-bar component.
 */

export type SyncEvent =
  | { type: "sync:start"; projectId: number | null; at: number }
  | { type: "sync:stage"; projectId: number | null; at: number; stage: string }
  | { type: "sync:done"; projectId: number | null; at: number; durationMs: number }
  | { type: "sync:error"; projectId: number | null; at: number; message: string };

export function isSyncEvent(value: unknown): value is SyncEvent {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return t === "sync:start" || t === "sync:stage" || t === "sync:done" || t === "sync:error";
}
