// packages/core/src/journal/strict-mode.ts
import { READ_ONLY_TOOL_NAMES } from "./patterns/tool-classes.js";

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName);
}

export function shouldBlock(
  mode: "lenient" | "strict" | "mechanical-only",
  toolName: string,
  status: { backlog_events: number },
  bypass: boolean,
): boolean {
  if (mode !== "strict") return false;
  if (bypass) return false;
  if (!isReadOnlyTool(toolName)) return false;
  return status.backlog_events > 0;
}

export function backlogErrorPayload(status: {
  backlog_events: number;
  backlog_oldest_age_hours: number | null;
}): object {
  return {
    isError: true,
    code: "JOURNAL_BACKLOG",
    message: `${status.backlog_events} events pending distillation${
      status.backlog_oldest_age_hours
        ? ` (oldest: ${status.backlog_oldest_age_hours.toFixed(1)}h ago)`
        : ""
    }. Call journal.distill before search/read, or pass journal_bypass: true to override.`,
    next_action: "journal.distill",
  };
}
