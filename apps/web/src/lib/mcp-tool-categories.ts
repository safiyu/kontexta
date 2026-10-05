export type ToolCategory =
  | "Read"
  | "Write"
  | "Search"
  | "Tags & Favorites"
  | "Folders & Projects"
  | "Versioning"
  | "Discovery"
  | "Calendar"
  | "Hands";

export const CATEGORY_ORDER: ToolCategory[] = [
  "Read",
  "Write",
  "Search",
  "Tags & Favorites",
  "Folders & Projects",
  "Versioning",
  "Discovery",
  "Calendar",
  "Hands",
];

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // Read
  "files_read": "Read",
  "files_read_outline": "Read",
  "files_describe": "Read",
  "files_list": "Read",
  "admin_get_profile": "Read",
  "admin_refresh_session_context": "Read",
  "folders_list": "Folders & Projects",
  "projects_list": "Folders & Projects",
  "tags_list": "Tags & Favorites",
  // Write
  "files_create": "Write",
  "files_update": "Write",
  "files_delete": "Write",
  "files_move": "Write",
  "folders_create": "Folders & Projects",
  "folders_delete": "Folders & Projects",
  "projects_register": "Folders & Projects",
  "admin_onboard_agent": "Folders & Projects",
  "admin_transfer_agent_context": "Folders & Projects",
  "journal_write": "Write",
  "journal_distill": "Write",
  "journal_status": "Discovery",
  "journal_housekeep": "Write",
  "journal_commit_upgrades": "Write",
  "resources_clip_url": "Write",
  "resources_add_report": "Write",
  "resources_delete_report": "Write",
  "resources_list_reports": "Read",
  "resources_export_report": "Discovery",
  // Search
  "files_search": "Search",
  "files_regex_search": "Search",
  "files_find_related": "Search",
  // Tags & Favorites
  "tags_add": "Tags & Favorites",
  "tags_remove": "Tags & Favorites",
  "tags_set_favorite": "Tags & Favorites",
  "tags_search": "Tags & Favorites",
  "tags_suggest": "Tags & Favorites",
  // Versioning
  "files_get_history": "Versioning",
  "files_get_diff": "Versioning",
  "files_restore": "Versioning",
  "admin_commit_backup": "Versioning",
  // Discovery
  "admin_overview": "Discovery",
  "projects_map": "Discovery",
  "files_diff_against_disk": "Discovery",
  "projects_refresh_index": "Discovery",
  // Calendar
  "calendar_entities_add": "Calendar",
  "calendar_entities_update": "Calendar",
  "calendar_entities_delete": "Calendar",
  "calendar_entities_list": "Calendar",
  "calendar_entities_link": "Calendar",
  "calendar_events_add": "Calendar",
  "calendar_events_update": "Calendar",
  "calendar_events_delete": "Calendar",
  "calendar_events_list": "Calendar",
  "calendar_events_conflicts": "Calendar",
  "calendar_export_ics": "Calendar",
  // Hands
  "hands_list": "Hands",
  "hands_reload": "Hands",
  "hands_confirm": "Hands",
};
