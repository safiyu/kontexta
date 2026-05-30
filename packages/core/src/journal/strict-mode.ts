// packages/core/src/journal/strict-mode.ts
const READ_ONLY_TOOLS = new Set([
  "search", "regex_search", "grep_in_file", "bundle_search",
  "read_file", "read_files", "read_section", "read_file_outline", "read_file_lines",
  "read_file_by_path", "describe_file",
  "list_files", "list_folders", "list_projects", "list_tags", "list_hands",
  "stats", "whats_new", "find_related", "project_map", "suggest_tags",
  "get_history", "get_diff",
]);

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
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
    }. Call distill_journal before search/read, or pass journal_bypass: true to override.`,
    next_action: "distill_journal",
  };
}
