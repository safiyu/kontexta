import type { PatternDetector } from "./index.js";

const TAG_TOOLS = new Set(["add_tags", "remove_tags", "tag_search_results"]);

export const taggingPassDetector: PatternDetector = {
  name: "tagging-pass",
  detect(events) {
    const calls = events.filter((e) => e.event === "tool_call");
    if (calls.length === 0) return null;
    const tagCalls = calls.filter((e) => TAG_TOOLS.has(e.tool ?? ""));
    if (tagCalls.length < 3) return null;
    const writeCalls = calls.filter(
      (e) => (e.tool ?? "").startsWith("update_") || (e.tool ?? "").startsWith("create_")
    );
    if (writeCalls.length > tagCalls.length) return null;
    return {
      name: "tagging-pass",
      summary: `tagging pass: ${tagCalls.length} tag operation(s)`,
      details: [`${tagCalls.length} tag-modifying calls`, `${writeCalls.length} content writes`],
      tags: ["tagging-pass", "organize"],
    };
  },
};
