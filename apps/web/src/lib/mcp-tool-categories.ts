export type ToolCategory =
  | "Read"
  | "Write"
  | "Search"
  | "Tags & Favorites"
  | "Folders & Projects"
  | "Versioning"
  | "Discovery"
  | "Hands";

export const CATEGORY_ORDER: ToolCategory[] = [
  "Read",
  "Write",
  "Search",
  "Tags & Favorites",
  "Folders & Projects",
  "Versioning",
  "Discovery",
  "Hands",
];

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // Read
  read_file: "Read",
  read_files: "Read",
  read_file_lines: "Read",
  read_file_outline: "Read",
  read_section: "Read",
  read_file_by_path: "Read",
  describe_file: "Read",
  list_files: "Read",
  list_folders: "Folders & Projects",
  list_projects: "Folders & Projects",
  list_tags: "Tags & Favorites",
  // Write
  create_file: "Write",
  create_files: "Write",
  update_file: "Write",
  update_file_section: "Write",
  delete_file: "Write",
  delete_files: "Write",
  move_file: "Write",
  create_folder: "Folders & Projects",
  delete_folder: "Folders & Projects",
  register_project: "Folders & Projects",
  onboard_agent: "Folders & Projects",
  journal_note: "Write",
  journal_intent: "Write",
  journal_append: "Write",
  distill_journal: "Write",
  journal_status: "Discovery",
  housekeep_journal: "Write",
  distill_journal_commit_upgrades: "Write",
  clip_url: "Write",
  // Search
  search: "Search",
  bundle_search: "Search",
  regex_search: "Search",
  grep_in_file: "Search",
  find_related: "Search",
  // Tags & Favorites
  add_tags: "Tags & Favorites",
  remove_tags: "Tags & Favorites",
  set_favorite: "Tags & Favorites",
  tag_search_results: "Tags & Favorites",
  suggest_tags: "Tags & Favorites",
  // Versioning
  get_history: "Versioning",
  get_diff: "Versioning",
  restore_file: "Versioning",
  commit_backup: "Versioning",
  // Discovery
  stats: "Discovery",
  whats_new: "Discovery",
  project_map: "Discovery",
  diff_against_disk: "Discovery",
  refresh_index: "Discovery",
  // Hands
  list_hands: "Hands",
  reload_hands: "Hands",
  confirm_hand: "Hands",
  describe_hands_schema: "Hands",
};
