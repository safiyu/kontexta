import type { PatternDetector } from "./index.js";

const READ_ONLY_TOOLS = new Set([
  // dot-notation
  "files.search", "files.regex_search", "files.grep", "files.bundle_search",
  "files.read", "files.read_many", "files.read_section", "files.read_outline",
  "files.describe", "files.list", "folders.list", "projects.list",
  "admin.stats", "admin.whats_new", "files.find_related", "projects.map",
  // legacy
  "search", "regex_search", "grep_in_file", "bundle_search",
  "read_file", "read_files", "read_section", "read_file_outline",
  "describe_file", "list_files", "list_folders", "list_projects",
  "stats", "whats_new", "find_related", "project_map",
]);

export const readOnlyInvestigationDetector: PatternDetector = {
  name: "read-only-investigation",
  detect(events) {
    const calls = events.filter((e) => e.event === "tool_call" && e.tool);
    if (calls.length < 3) return null;
    const allReadOnly = calls.every((e) => READ_ONLY_TOOLS.has(e.tool!));
    if (!allReadOnly) return null;
    return {
      name: "read-only-investigation",
      summary: `read-only investigation: ${calls.length} read calls, no writes`,
      details: [`${calls.length} read-only tool calls`, "zero write operations"],
      tags: ["read-only-investigation", "investigation"],
    };
  },
};
