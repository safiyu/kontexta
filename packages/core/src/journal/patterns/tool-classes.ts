// Single source of truth for classifying MCP tool calls in journal pattern
// detectors. Kept in sync with apps/mcp/src/index.ts + calendar-tools.ts +
// scripts/build-smithery-bundle.mjs. Current (5.0.0+), pre-5.0.0 dotted, and
// legacy snake_case names are all listed so historical journal entries
// recorded under any prior naming scheme still classify.

export const READ_ONLY_TOOL_NAMES = new Set<string>([
  // dot-notation (current, 5.0.0+)
  "admin.get_profile", "admin.overview", "admin.refresh_session_context",
  "calendar.entities.list", "calendar.events.conflicts", "calendar.events.list", "calendar.export_ics",
  "files.describe", "files.diff_against_disk", "files.find_related",
  "files.get_diff", "files.get_history", "files.list",
  "files.read", "files.read_outline", "files.regex_search", "files.search",
  "folders.list",
  "hands.list",
  "journal.status",
  "projects.list", "projects.map",
  "resources.export_report", "resources.list_reports",
  "tags.list", "tags.suggest",
  // dot-notation (4.7.x, pre-consolidation — kept for historical journal entries)
  "admin.stats", "admin.whats_new",
  "files.bundle_search", "files.grep", "files.read_by_path", "files.read_lines",
  "files.read_many", "files.read_section",
  "hands.describe_schema",
  // legacy (pre-4.7.1)
  "search", "regex_search", "grep_in_file", "bundle_search",
  "read_file", "read_files", "read_section", "read_file_outline", "read_file_lines", "read_file_by_path",
  "describe_file", "list_files", "list_folders", "list_projects", "list_tags", "list_hands",
  "stats", "whats_new", "find_related", "project_map",
  "get_history", "get_diff", "diff_against_disk",
  "describe_hands_schema", "get_profile", "refresh_session_context",
  "calendar_list_entities", "calendar_list_events", "calendar_conflicts", "calendar_export_ics",
  "list_report_resources", "export_report",
  "suggest_tags", "journal_status",
]);

const WRITE_TOOL_NAMES = new Set<string>([
  // dot-notation (current, 5.0.0+)
  "admin.commit_backup", "admin.onboard_agent", "admin.transfer_agent_context",
  "calendar.entities.add", "calendar.entities.delete", "calendar.entities.link", "calendar.entities.update",
  "calendar.events.add", "calendar.events.delete", "calendar.events.update",
  "files.create", "files.delete", "files.move",
  "files.restore", "files.update",
  "folders.create", "folders.delete",
  "hands.confirm", "hands.reload",
  "journal.commit_upgrades", "journal.distill", "journal.housekeep", "journal.write",
  "projects.refresh_index", "projects.register",
  "resources.add_report", "resources.clip_url", "resources.delete_report",
  "tags.add", "tags.remove", "tags.search", "tags.set_favorite",
  // dot-notation (4.7.x, pre-consolidation — kept for historical journal entries)
  "files.create_many", "files.delete_many", "files.update_section",
  "journal.append", "journal.intent", "journal.note",
]);

const LEGACY_WRITE_PREFIXES = [
  "update_", "create_", "delete_", "move_", "add_", "remove_", "restore_", "clip_",
  "onboard_", "transfer_", "commit_", "housekeep_", "distill_", "register_",
  "reload_", "refresh_index", "set_favorite", "tag_search_results",
  "calendar_add_", "calendar_update_", "calendar_delete_", "calendar_link_",
  "journal_note", "journal_intent", "journal_append",
];

export function isWriteToolName(name: string): boolean {
  if (WRITE_TOOL_NAMES.has(name)) return true;
  return LEGACY_WRITE_PREFIXES.some((p) => name.startsWith(p));
}
