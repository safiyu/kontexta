import type { PatternDetector } from "./index.js";
import { READ_ONLY_TOOL_NAMES } from "./tool-classes.js";

export const readOnlyInvestigationDetector: PatternDetector = {
  name: "read-only-investigation",
  detect(events) {
    const calls = events.filter((e) => e.event === "tool_call" && e.tool);
    if (calls.length < 3) return null;
    const allReadOnly = calls.every((e) => READ_ONLY_TOOL_NAMES.has(e.tool!));
    if (!allReadOnly) return null;
    return {
      name: "read-only-investigation",
      summary: `read-only investigation: ${calls.length} read calls, no writes`,
      details: [`${calls.length} read-only tool calls`, "zero write operations"],
      tags: ["read-only-investigation", "investigation"],
    };
  },
};
