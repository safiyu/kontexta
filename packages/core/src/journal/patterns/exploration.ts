import type { PatternDetector } from "./index.js";

const READ_TOOLS = new Set([
  "search", "regex_search", "grep_in_file", "bundle_search",
  "read_file", "read_files", "read_section", "read_file_outline", "describe_file",
]);
const WRITE_TOOLS_PREFIX = ["update_", "create_", "delete_", "move_"];

export const explorationDetector: PatternDetector = {
  name: "exploration",
  detect(events) {
    const calls = events.filter((e) => e.event === "tool_call" && e.tool);
    if (calls.length < 5) return null;
    const reads = calls.filter((e) => READ_TOOLS.has(e.tool!));
    const writes = calls.filter((e) =>
      WRITE_TOOLS_PREFIX.some((p) => e.tool!.startsWith(p))
    );
    if (reads.length < 5 || writes.length > 0) return null;
    const filesTouched = new Set<string>();
    for (const e of calls) for (const f of e.touched ?? []) filesTouched.add(f);
    return {
      name: "exploration",
      summary: `investigation phase: ${reads.length} read calls across ${filesTouched.size} files`,
      details: [`${reads.length} read-only tool calls`, "no write operations"],
      tags: ["exploration", "investigation"],
    };
  },
};
