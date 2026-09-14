import type { PatternDetector } from "./index.js";
import { READ_ONLY_TOOL_NAMES, isWriteToolName } from "./tool-classes.js";

export const explorationDetector: PatternDetector = {
  name: "exploration",
  detect(events) {
    const calls = events.filter((e) => e.event === "tool_call" && e.tool);
    if (calls.length < 5) return null;
    const reads = calls.filter((e) => READ_ONLY_TOOL_NAMES.has(e.tool!));
    const writes = calls.filter((e) => isWriteToolName(e.tool!));
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
