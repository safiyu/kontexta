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
  "files.read": "Read",
  "files.read_outline": "Read",
  "files.describe": "Read",
  "files.list": "Read",
  "admin.get_profile": "Read",
  "admin.refresh_session_context": "Read",
  "folders.list": "Folders & Projects",
  "projects.list": "Folders & Projects",
  "tags.list": "Tags & Favorites",
  // Write
  "files.create": "Write",
  "files.update": "Write",
  "files.delete": "Write",
  "files.move": "Write",
  "folders.create": "Folders & Projects",
  "folders.delete": "Folders & Projects",
  "projects.register": "Folders & Projects",
  "admin.onboard_agent": "Folders & Projects",
  "admin.transfer_agent_context": "Folders & Projects",
  "journal.write": "Write",
  "journal.distill": "Write",
  "journal.status": "Discovery",
  "journal.housekeep": "Write",
  "journal.commit_upgrades": "Write",
  "resources.clip_url": "Write",
  "resources.add_report": "Write",
  "resources.delete_report": "Write",
  "resources.list_reports": "Read",
  "resources.export_report": "Discovery",
  // Search
  "files.search": "Search",
  "files.regex_search": "Search",
  "files.find_related": "Search",
  // Tags & Favorites
  "tags.add": "Tags & Favorites",
  "tags.remove": "Tags & Favorites",
  "tags.set_favorite": "Tags & Favorites",
  "tags.search": "Tags & Favorites",
  "tags.suggest": "Tags & Favorites",
  // Versioning
  "files.get_history": "Versioning",
  "files.get_diff": "Versioning",
  "files.restore": "Versioning",
  "admin.commit_backup": "Versioning",
  // Discovery
  "admin.overview": "Discovery",
  "projects.map": "Discovery",
  "files.diff_against_disk": "Discovery",
  "projects.refresh_index": "Discovery",
  // Calendar
  "calendar.entities.add": "Calendar",
  "calendar.entities.update": "Calendar",
  "calendar.entities.delete": "Calendar",
  "calendar.entities.list": "Calendar",
  "calendar.entities.link": "Calendar",
  "calendar.events.add": "Calendar",
  "calendar.events.update": "Calendar",
  "calendar.events.delete": "Calendar",
  "calendar.events.list": "Calendar",
  "calendar.events.conflicts": "Calendar",
  "calendar.export_ics": "Calendar",
  // Hands
  "hands.list": "Hands",
  "hands.reload": "Hands",
  "hands.confirm": "Hands",
};
